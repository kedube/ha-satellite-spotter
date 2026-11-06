/** The one way text goes into HTML here. */

/** Escape text for use in HTML, in content or in an attribute; nothing for no value. */
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
