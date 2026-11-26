/** The `inverse_patch` of a body event that has no way back: a text that cannot be encoded as a patch (services/eventLog/bodyPatch.ts, which re-exports
 *  it), an imported version, a change another node made (spine/receivedEvents.ts). A restore of such an event is refused (services/eventRestore/restore.ts
 *  history_incomplete). Its own file, with no imports: the event log's patch code and the spine's received events both name it. */
export const NO_INVERSE_PATCH = "no-inverse-patch";
