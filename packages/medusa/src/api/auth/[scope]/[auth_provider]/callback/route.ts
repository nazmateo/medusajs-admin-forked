import { ModuleRegistrationName } from "@medusajs/modules-sdk"
import { AuthenticationInput, IAuthModuleService } from "@medusajs/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  remoteQueryObjectFromString,
} from "@medusajs/utils"
import { MedusaRequest, MedusaResponse } from "../../../../../types/routing"
import { generateJwtToken } from "../../../../utils/auth/token"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { scope, auth_provider } = req.params
  const actorType = scope === "admin" ? "user" : "customer"

  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)
  const service: IAuthModuleService = req.scope.resolve(
    ModuleRegistrationName.AUTH
  )

  const authData = {
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: req.body,
    authScope: scope,
    protocol: req.protocol,
  } as AuthenticationInput

  const { success, error, authIdentity, successRedirectUrl } =
    await service.validateCallback(auth_provider, authData)

  const queryObject = remoteQueryObjectFromString({
    entryPoint: "auth_identity",
    fields: [`${actorType}.id`],
    variables: { id: authIdentity.id },
  })
  const [actorData] = await remoteQuery(queryObject)
  const entityId = actorData?.[actorType]?.id

  if (success) {
    const { http } = req.scope.resolve(
      ContainerRegistrationKeys.CONFIG_MODULE
    ).projectConfig

    const { jwtSecret, jwtExpiresIn } = http
    // TODO: Clean up mapping between scope and actor type
    const token = generateJwtToken(
      {
        actor_id: entityId,
        actor_type: actorType,
        auth_identity_id: authIdentity.id,
        app_metadata: {},
        scope,
      },
      {
        secret: jwtSecret,
        expiresIn: jwtExpiresIn,
      }
    )

    if (successRedirectUrl) {
      const url = new URL(successRedirectUrl!)
      url.searchParams.append("access_token", token)

      return res.redirect(url.toString())
    }

    return res.json({ token })
  }

  throw new MedusaError(
    MedusaError.Types.UNAUTHORIZED,
    error || "Authentication failed"
  )
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  await GET(req, res)
}
