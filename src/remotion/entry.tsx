/**
 * Remotion entry point for server-side rendering.
 * This file calls registerRoot() which is required by @remotion/bundler.
 *
 * IMPORTANT: This file is ONLY used by the Remotion bundler for export/render.
 * The Next.js app uses Root.tsx components directly via the Player component.
 * Keeping registerRoot() in a separate file prevents it from executing
 * as a side-effect when Next.js processes the app.
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
