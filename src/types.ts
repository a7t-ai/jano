/**
 * A model name as it appears in the `model` field of an OpenAI Chat
 * Completions request and in the user's `models.json`. Just an alias for
 * string. Jano places no constraints on naming.
 */
export type ModelName = string;

/**
 * One backend, as declared in `models.json`.
 *
 * `name` is what callers should send in the `model` field. `aliases` are
 * additional strings the picker will match against (case-insensitive),
 * useful for back-compat with callers that send a full GGUF id.
 */
export type ModelDef = {
  name: ModelName;
  url: string;
  aliases?: string[];
};

/**
 * Allows the dispatcher to short-circuit a queued request without spinning
 * the upstream — used both for "backend is known bad" (fail fast with 503)
 * and "client already disconnected" (drain quietly).
 */
export type FailFn = (status: number, message: string) => Promise<void>;
export type IsAliveFn = () => boolean;
