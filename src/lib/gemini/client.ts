import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";

/**
 * Lazy Gemini client.
 *
 * The API key is required only when a model is actually CALLED (at request time),
 * not when this module is imported. This keeps `next build` / CI / deploys working
 * without the secret present, while still failing loudly on first real use if it
 * is unset. (Previously this module threw at import time, breaking the build.)
 */

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

const generationConfig = {
  temperature: 0.1,
  responseMimeType: "application/json",
} as const;

const _models = new Map<string, GenerativeModel>();
function getModel(model: string): GenerativeModel {
  let m = _models.get(model);
  if (!m) {
    m = getGenAI().getGenerativeModel({ model, generationConfig });
    _models.set(model, m);
  }
  return m;
}

/** A model handle that defers construction (and the key requirement) until first use. */
function lazyModel(model: string): GenerativeModel {
  return new Proxy({} as GenerativeModel, {
    get(_target, prop) {
      const real = getModel(model) as unknown as Record<PropertyKey, unknown>;
      const value = real[prop];
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

export const geminiFlash = lazyModel("gemini-2.5-flash");
export const geminiPro = lazyModel("gemini-2.5-pro");
/** Fallback model on newer Gemini 3.x infrastructure */
export const geminiFallback = lazyModel("gemini-3.1-pro-preview");

/** Lazy GoogleGenerativeAI handle (key required only on use). */
export const genAI = new Proxy({} as GoogleGenerativeAI, {
  get(_target, prop) {
    const real = getGenAI() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});
