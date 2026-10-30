# MiniMax H3 prompting

Use for the supported T2V, I2V and image R2V modes. Additional model capabilities do not add audio/video references, last-frame inputs or ControlNet to this tool. Inspect reference pixels and follow user intent.

## Structure

- T2V: integrated_multimodal_description, overall_soundscape and non_diegetic_music cover audiovisual events, ambience and score.
- I2V: use the first-frame alignment opening and three sections in [requests.json](requests.json); preserve visible identity/composition and describe subsequent motion.
- R2V: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape and non_diegetic_music. Upload order defines Picture 1/2; give reused subjects stable Subject labels, stating preserved/changed traits. Do not invent audio/video references.

## Content

Prefer English scene/action instructions; retain dialogue and visible text in their requested language. Start with Shot 1; later cuts use increasing timestamps within the duration. A continuous action can stay in one shot. Describe subjects, observable action, camera and sound rather than padding a plot.

Keep speaker IDs stable and put dialogue in its relevant shot with `<d>` tags. Respect requested silence/music choices. Check reference identity, literal text and feasible timing. For graphs without negative conditioning, avoid ban lists; increasing CFG is not a substitute for clear positive instructions. Output audio still needs inspection.

## Parameters and acceptance

Send seconds through duration_seconds and retain frame-grid conversion. Use live Turbo/sampling bindings instead of overriding defaults with tutorial numbers. Do not add preview generations outside user scope. Inspect actual dimensions, duration, playback and content before proposing feedback-driven iteration. Technical completion is distinct from quality acceptance.

Sources, checked 2026-10-27: [Comfy guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide), MiniMax [base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) and [reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md). Use only the tool-supported subset.
