import {
  CreateOrderShippingMethodDTO,
  FulfillmentWorkflow,
  OrderDTO,
  OrderWorkflow,
  ShippingOptionDTO,
  WithCalculatedPrice,
} from "@medusajs/types"
import {
  createStep,
  createWorkflow,
  transform,
  WorkflowData,
} from "@medusajs/workflows-sdk"
import { createLinkStep, useRemoteQueryStep } from "../../common"
import {
  arrayDifference,
  ContainerRegistrationKeys,
  isDefined,
  MathBN,
  MedusaError,
  Modules,
  remoteQueryObjectFromString,
} from "@medusajs/utils"
import { updateOrderTaxLinesStep } from "../steps"
import { createReturnStep } from "../steps/create-return"
import { createFulfillmentWorkflow } from "../../fulfillment"

function throwIfOrderIsCancelled({ order }: { order: OrderDTO }) {
  // TODO: need work, check canceled
  if (false /*order.canceled_at*/) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Order with id ${order.id} has been cancelled.`
    )
  }
}

function throwIfItemsDoesNotExistsInOrder({
  order,
  inputItems,
}: {
  order: Pick<OrderDTO, "id" | "items">
  inputItems: OrderWorkflow.CreateOrderReturnWorkflowInput["items"]
}) {
  const orderItemIds = order.items?.map((i) => i.id) ?? []
  const inputItemIds = inputItems.map((i) => i.id)
  const diff = arrayDifference(inputItemIds, orderItemIds)

  if (diff.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Items with ids ${diff.join(", ")} does not exist in order with id ${
        order.id
      }.`
    )
  }
}

async function validateReturnReasons(
  {
    orderId,
    inputItems,
  }: {
    orderId: string
    inputItems: OrderWorkflow.CreateOrderReturnWorkflowInput["items"]
  },
  { container }
) {
  const reasonIds = inputItems.map((i) => i.reason_id).filter(Boolean)
  if (!reasonIds.length) {
    return
  }

  const remoteQuery = container.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  const remoteQueryObject = remoteQueryObjectFromString({
    entryPoint: "return_reasons",
    fields: [
      "id",
      "parent_return_reason_id",
      "parent_return_reason",
      "return_reason_children.id",
    ],
    variables: { id: [inputItems.map((item) => item.reason_id)], limit: null },
  })

  const returnReasons = await remoteQuery(remoteQueryObject)

  const reasons = returnReasons.map((r) => r.id)
  const hasInvalidReasons = returnReasons
    .filter(
      // We do not allow for root reason to be applied
      (reason) => reason.return_reason_children.length > 0
    )
    .map((r) => r.id)
  const hasNonExistingReasons = arrayDifference(reasonIds, reasons)

  if (hasNonExistingReasons.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Return reason with id ${hasNonExistingReasons.join(
        ", "
      )} does not exists.`
    )
  }

  if (hasInvalidReasons.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Cannot apply return reason with id ${hasInvalidReasons.join(
        ", "
      )} to order with id ${orderId}. Return reason has nested reasons.`
    )
  }
}

function prepareShippingMethodData({
  orderId,
  inputShippingOption,
  returnShippingOption,
}: {
  orderId: string
  inputShippingOption: OrderWorkflow.CreateOrderReturnWorkflowInput["return_shipping"]
  returnShippingOption: ShippingOptionDTO & WithCalculatedPrice
}) {
  const obj: CreateOrderShippingMethodDTO = {
    name: returnShippingOption.name,
    order_id: orderId,
    shipping_option_id: returnShippingOption.id,
    amount: 0,
    data: {},
    // Computed later in the flow
    tax_lines: [],
    adjustments: [],
  }

  if (isDefined(inputShippingOption.price) && inputShippingOption.price >= 0) {
    obj.amount = inputShippingOption.price
  } else {
    if (returnShippingOption.price_type === "calculated") {
      // TODO: retrieve calculated price and assign to amount
    } else {
      obj.amount = returnShippingOption.calculated_price.calculated_amount
    }
  }

  return obj
}

function validateCustomRefundAmount({
  order,
  refundAmount,
}: {
  order: Pick<OrderDTO, "item_total">
  refundAmount?: number
}) {
  // validate that the refund prop input is less than order.item_total (item total)
  // TODO: Probably this amount should be retrieved from the payments linked to the order
  if (refundAmount && MathBN.gt(refundAmount, order.item_total)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Refund amount cannot be greater than order total.`
    )
  }
}

function prepareFulfillmentData({
  order,
  input,
  returnShippingOption,
}: {
  order: OrderDTO
  input: OrderWorkflow.CreateOrderReturnWorkflowInput
  returnShippingOption: {
    id: string
    provider_id: string
    service_zone: { fulfillment_set: { location?: { id: string } } }
  }
}) {
  const inputItems = input.items
  const orderItemsMap = new Map<string, Required<OrderDTO>["items"][0]>(
    order.items!.map((i) => [i.id, i])
  )
  const fulfillmentItems = inputItems.map((i) => {
    const orderItem = orderItemsMap.get(i.id)!
    return {
      line_item_id: i.id,
      quantity: i.quantity,
      return_quantity: i.quantity,
      title: orderItem.variant_title ?? orderItem.title,
      sku: orderItem.variant_sku || "",
      barcode: orderItem.variant_barcode || "",
    } as FulfillmentWorkflow.CreateFulfillmentItemWorkflowDTO
  })

  let locationId: string | undefined = input.location_id
  if (!locationId) {
    locationId = returnShippingOption.service_zone.fulfillment_set.location?.id
  }

  if (!locationId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Cannot create return without stock location, either provide a location or you should link the shipping option ${returnShippingOption.id} to a stock location.`
    )
  }

  return {
    input: {
      location_id: locationId,
      provider_id: returnShippingOption.provider_id,
      shipping_option_id: input.return_shipping.option_id,
      items: fulfillmentItems,
      labels: [] as FulfillmentWorkflow.CreateFulfillmentLabelWorkflowDTO[],
      delivery_address: order.shipping_address ?? ({} as any), // TODO: should it be the stock location address?
      order: {} as FulfillmentWorkflow.CreateFulfillmentOrderWorkflowDTO, // TODO see what todo here, is that even necessary?
      order_id: input.order_id,
    },
  }
}

function prepareReturnShippingOptionQueryVariables({
  order,
  input,
}: {
  order: {
    currency_code: string
    region_id?: string
  }
  input: {
    return_shipping: OrderWorkflow.CreateOrderReturnWorkflowInput["return_shipping"]
  }
}) {
  const variables = {
    id: input.return_shipping.option_id,
    calculated_price: {
      context: {
        currency_code: order.currency_code,
      },
    },
  }

  if (order.region_id) {
    variables.calculated_price.context["region_id"] = order.region_id
  }

  return variables
}

const validationStep = createStep(
  "create-return-order-validation",
  async function (
    {
      order,
      input,
    }: {
      order
      input: OrderWorkflow.CreateOrderReturnWorkflowInput
    },
    context
  ) {
    throwIfOrderIsCancelled({ order })
    throwIfItemsDoesNotExistsInOrder({ order, inputItems: input.items })
    await validateReturnReasons(
      { orderId: input.order_id, inputItems: input.items },
      context
    )
    validateCustomRefundAmount({ order, refundAmount: input.refund_amount })
  }
)

export const createReturnOrderWorkflowId = "create-return-order"
export const createReturnOrderWorkflow = createWorkflow(
  createReturnOrderWorkflowId,
  function (
    input: WorkflowData<OrderWorkflow.CreateOrderReturnWorkflowInput>
  ): WorkflowData<void> {
    const order: OrderDTO = useRemoteQueryStep({
      entry_point: "orders",
      fields: [
        "id",
        "region_id",
        "currency_code",
        "total",
        "item_total",
        "items.*",
      ],
      variables: { id: input.order_id },
      list: false,
      throw_if_key_not_found: true,
    })

    validationStep({ order, input })

    const returnShippingOptionsVariables = transform(
      { input, order },
      prepareReturnShippingOptionQueryVariables
    )

    const returnShippingOption = useRemoteQueryStep({
      entry_point: "shipping_options",
      fields: [
        "id",
        "price_type",
        "name",
        "provider_id",
        "calculated_price.calculated_amount",
        "service_zone.fulfillment_set.location.id",
      ],
      variables: returnShippingOptionsVariables,
      list: false,
      throw_if_key_not_found: true,
    }).config({ name: "return-shipping-option" })

    const shippingMethodData = transform(
      {
        orderId: input.order_id,
        inputShippingOption: input.return_shipping,
        returnShippingOption,
      },
      prepareShippingMethodData
    )

    createReturnStep({
      order_id: input.order_id,
      items: input.items,
      shipping_method: shippingMethodData,
      created_by: input.created_by,
    })

    updateOrderTaxLinesStep({
      order_id: input.order_id,
      shipping_methods: [shippingMethodData as any], // The types does not seems correct in that step and expect too many things compared to the actual needs
    })

    const fulfillmentData = transform(
      { order, input, returnShippingOption },
      prepareFulfillmentData
    )

    createFulfillmentWorkflow.runAsStep(fulfillmentData)

    // TODO call the createReturn from the fulfillment provider
  }
)
