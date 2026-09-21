/**
 * Local replacement for `@repo/messaging/types`. Generic helpers that map a
 * "socket message map" (see `../types/messages-ws.ts`) to the message-type
 * keys and their payload / response shapes.
 */

/** Union of all message-type names in the map. */
export type MessageType<TMap> = keyof TMap & string;

/** Payload type for a given message type. */
export type MessagePayload<TMap, T extends keyof TMap> = TMap[T] extends {
  payload: infer P;
}
  ? P
  : never;

/** Response type for a given message type. */
export type MessageResponse<TMap, T extends keyof TMap> = TMap[T] extends {
  response: infer R;
}
  ? R
  : never;
