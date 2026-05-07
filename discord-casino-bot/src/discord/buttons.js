// Button id format: ns:action[:p1[:p2...]]
// Keep total <= 100 chars (Discord limit).
export const enc = (...parts) => parts.join(':');
export const dec = (id) => id.split(':');
