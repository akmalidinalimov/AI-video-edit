<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Video editing / style cloning

Before working on any video-edit or style-clone task, read
`docs/style-cloning-principles.md` — 13 learned rules for faithfully
replicating a reference layout (measure-vs-apply separation, deterministic CV
coordinate measurement, multi-frame median, glitch-free PIP motion, overlay-vs-
content text classification, single-pass FFmpeg, etc.). They are general and
apply to any edit style.
