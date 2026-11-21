// Portuguese (pt-BR) UI catalog — errors: cross-cutting error copy (errors.* keys).
// Namespaces owned by this file: errors.*.
// Same keys in pt/, en/ and es/; merged by ../index.ts (see ../catalogs.test.ts).
// No keys yet.
import type en from '../en/errors.ts'

// Typed against the EN catalog: a key missing here (or not in EN) is a type error.
const catalog: Record<keyof typeof en, string> = {}

export default catalog
