/** The chat view's type id. Its own module so code that only needs the id (leaf lookups in
 * `utils/chatLocation.ts`, which the data store imports) does not pull in the view itself. */
export const VIEW_TYPE_CHAT = "smart-second-brain-chat";
