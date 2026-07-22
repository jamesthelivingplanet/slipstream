export type ChannelHandler = (args: unknown[]) => Promise<unknown>
export type ChannelHandlerMap = Record<string, ChannelHandler>
