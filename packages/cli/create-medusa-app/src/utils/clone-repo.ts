import execute from "./execute.js"
import { Ora } from "ora"
import { isAbortError } from "./create-abort-controller.js"
import logMessage from "./log-message.js"
import fs from "fs"
import path from "path"

type CloneRepoOptions = {
  directoryName?: string
  repoUrl?: string
  abortController?: AbortController
  verbose?: boolean
}

const DEFAULT_REPO = "https://github.com/medusajs/medusa-starter-default"
const V2_BRANCH = "feat/v2"

export default async function cloneRepo({
  directoryName = "",
  repoUrl,
  abortController,
  verbose = false,
}: CloneRepoOptions) {
  await execute(
    [
      `git clone ${repoUrl || DEFAULT_REPO} -b ${V2_BRANCH} ${directoryName}`,
      {
        signal: abortController?.signal,
      },
    ],
    { verbose }
  )
}

export async function runCloneRepo({
  projectName,
  repoUrl,
  abortController,
  spinner,
  verbose = false,
}: {
  projectName: string
  repoUrl: string
  abortController: AbortController
  spinner: Ora
  verbose?: boolean
}) {
  try {
    await cloneRepo({
      directoryName: projectName,
      repoUrl,
      abortController,
      verbose,
    })

    deleteGitDirectory(projectName)
  } catch (e) {
    if (isAbortError(e)) {
      process.exit()
    }

    spinner.stop()
    logMessage({
      message: `An error occurred while setting up your project: ${e}`,
      type: "error",
    })
  }
}

function deleteGitDirectory(projectDirectory: string) {
  fs.rmSync(path.join(projectDirectory, ".git"), {
    recursive: true,
    force: true,
  })
}
