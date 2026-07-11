import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import { ShareNext } from "./share-next"

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

const publicShareDisabledMessage =
  "Public session sharing is not available. Public share revocation material remains quarantined locally; Ruying Code will not contact the public service automatically. Ask an administrator to revoke the share using its locally stored share ID. Do not paste the share secret into chat or logs. Remove the local record only after remote revocation is confirmed."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
      throw new Error(publicShareDisabledMessage)
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
      throw new Error(publicShareDisabledMessage)
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      return yield* session.create(input)
    })

    return Service.of({ create, share, unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, ShareNext.node],
})

export * as SessionShare from "./session"
