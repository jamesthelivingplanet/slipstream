/**
 * Wire protocol envelope types for the WebSocket transport.
 * Dependency-free so both the server (electron/) and renderer (src/) can import this.
 */

/** Client → server: invoke a channel by name */
export interface WireReq {
  t: 'req'
  id: string
  channel: string
  args: unknown[]
}

/** Server → client: response to a WireReq */
export type WireRes =
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: string }

/** Server → client: unsolicited push (session data, session status) */
export interface WirePush {
  t: 'push'
  channel: string
  args: unknown[]
}

/** Client → server: liveness probe (application-level heartbeat). */
export interface WirePing {
  t: 'ping'
}

/** Server → client: response to a WirePing. */
export interface WirePong {
  t: 'pong'
}
