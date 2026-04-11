# Demio — Product Description & Project Context

---

## What is Demio?

Demio is an AI-powered product demo video generation platform designed for SaaS companies, indie developers, and product teams who need to create compelling, professional demo videos without the overhead of screen recording, video editing, or hiring a production team.

The core value proposition is simple: **give Demio your product's URL and describe what you want to showcase — and Demio's AI agents will build the demo video for you.**

It removes the entire manual pipeline of: scripting → recording → editing → voiceover → export. Instead, the user describes intent and the AI handles execution, while keeping the human in the loop through a conversational chat interface where they can guide, refine, and adjust the output in real time.

---

## Who is it for?

**Primary users:**

- **SaaS founders and product teams** who need polished demo videos for their landing pages, investor decks, or sales outreach but don't have a dedicated video production resource
- **Developer tool companies** (like Workik) who frequently ship features and need demo videos updated regularly without going through a full production cycle each time
- **Growth and marketing teams** who run A/B tests on landing pages and need multiple variations of a product demo quickly
- **Sales teams** doing personalized outreach who want to send prospects a custom demo video specific to their use case

**Secondary users:**
- Freelancers and agencies building demo videos for clients
- Early-stage startups preparing for product launches or YC/accelerator applications

---

## The Core Problem Demio Solves

Creating a professional product demo video today requires:

1. Writing a script
2. Setting up a clean recording environment
3. Recording the screen (often multiple takes)
4. Editing in a tool like Premiere, CapCut, or Loom
5. Adding transitions, annotations, zoom effects
6. Recording or generating a voiceover
7. Adding captions
8. Exporting and compressing

This process takes hours to days, requires skill across multiple tools, and becomes a bottleneck every time the product changes. For teams shipping fast, this is unsustainable.

Demio collapses this entire pipeline into a single conversational interface.

---

## How Demio Works — The User Journey

### Step 1: Project Creation (Home Screen)

The user arrives at the Demio dashboard. If they're new, the home screen greets them with a single focused task: describe what they want to demo.

They provide two core inputs:
- **Product Domain** — the URL of their product (e.g. `workik.com`). Demio uses this to autonomously browse the product, understand its UI, features, and flows.
- **Product Description** — a natural language description of the product and specifically what aspect of it they want the demo to cover. This is the creative brief.

Optionally, the user can:
- Attach screenshots, existing video clips, or brand assets (logo, colors) to give the AI more context
- Connect a Figma link if the product is still in design phase
- Choose the AI model to use for generation (affecting quality, speed, and cost)

Once submitted, Demio creates a new project session and the AI agents begin working immediately.

### Step 2: AI Agent Execution (The Generation Pipeline)

Once the user submits, a coordinated set of AI agents begins working through a pipeline. The user can observe every step in real time via the chat interface:

**Agent Pipeline Stages:**

1. **Discovery Agent** — Visits the provided product domain, browses the product's website and any public-facing app, takes screenshots, understands the navigation flow, identifies key features, and extracts UI patterns. It reads landing page copy to understand positioning and messaging.

2. **Script Agent** — Based on the product description and what the Discovery Agent found, it writes a structured video script broken into scenes. Each scene has a goal (e.g., "Show the user creating a new project"), a UI interaction sequence, and suggested narration/voiceover text.

3. **Recording Agent** — Executes the script by navigating through the product's actual UI (in a sandboxed browser), performing the described interactions, and capturing screen recordings for each scene. It handles mouse movements, clicks, typing, and scrolling in a way that looks natural and intentional, not robotic.

4. **Composition Agent** — Takes the raw screen recordings and composes them into a cohesive video. It adds transitions between scenes, zoom/highlight effects to draw attention to key UI elements, lower-third labels to explain what's happening, and pacing adjustments to keep the video engaging.

5. **Voiceover Agent** — Generates a professional-sounding AI voiceover narrating the video based on the script. Users can choose from different voice profiles (tone, gender, accent, pace). Captions are auto-generated and synced.

6. **Render Agent** — Final compositing pass that applies branding (if provided), ensures consistent quality, and produces the output video file.

The user sees each of these stages appear progressively in the chat as the agents complete their work, with visual progress cards showing what's happening and how far along it is.

### Step 3: Real-Time Collaboration via Chat

The chat interface is not just a progress log — it is the primary control surface for guiding the AI.

At any point during or after generation, the user can:
- **Give directional feedback** — "Make the intro shorter", "The recording of the dashboard feels rushed, slow it down", "Add a scene showing the API integration"
- **Ask questions** — "What scenes did you include?", "What voice are you using?", "How long is the video?"
- **Make targeted edits** — "Regenerate only scene 4 with a different angle", "Change the voiceover to sound more conversational", "Add a branded outro with our logo"
- **Approve or reject** — The agent may pause and ask for user approval before proceeding at critical decision points (e.g., after script generation, before recording begins)

The AI agent responds conversationally, explains its decisions, and acts on feedback immediately. It is designed to feel like collaborating with a skilled video producer who happens to work at the speed of software.

### Step 4: Video Preview & Scene Management

As each scene is completed, it appears in the right-side video preview panel. The user doesn't wait for the entire video to finish — they see it being built scene by scene.

The scene navigator (filmstrip at the bottom of the preview panel) lets users jump between individual scenes, review each one, and selectively request changes without regenerating the entire video.

Once all scenes are complete, the full video is stitched together and available for preview in its entirety.

### Step 5: Export & Share

When satisfied, the user can:
- **Download** the final video as an MP4 file
- **Share** via a Demio-hosted link (a clean viewer page with no Demio branding on paid plans)
- Future: embed via iframe, push directly to Notion, Linear, or their website CMS

---

## Key Concepts & Mental Models

### Projects
Each "project" in Demio represents one demo video creation session. A project has a domain, a description, a chat history, a set of scenes, and a final video output. Projects are persistent — the user can come back, continue refining, and re-export.

### Scenes
A video is composed of multiple scenes. Each scene is an atomic unit — it has a specific UI flow it captures, narration text, and a duration. Scenes can be individually regenerated without affecting others. This makes iteration fast and surgical.

### The Agent
From the user's perspective, there is one "Demio Agent" they're talking to in chat. Behind the scenes this is orchestrated across multiple specialized agents, but the user doesn't need to know or care about this. The experience is a single intelligent collaborator.

### Models
Demio is model-agnostic. Users can choose which underlying AI model powers their session. Different models offer different tradeoffs — faster but simpler outputs vs. slower but highly polished results. This also matters for cost, so users on different pricing tiers may have access to different model options.

### Attachments
Users can attach additional context at any point — not just at the start. Attaching a competitor's demo video mid-session ("make ours feel more like this"), or a new screenshot after a product update, is a valid and encouraged workflow.

---

## Core Features

### Must-Have (V1)
- Domain input with live product browsing by AI agents
- Natural language product description input
- Automated multi-agent video generation pipeline
- Real-time progress visibility in chat
- Conversational feedback and adjustment mid-generation
- Scene-by-scene preview as generation completes
- Scene navigator (filmstrip)
- Individual scene regeneration
- AI voiceover generation with voice selection
- Auto-generated captions
- MP4 export
- Project persistence (save and return)
- Model selection

### Nice-to-Have (V2+)
- Shareable hosted video link with custom viewer
- Brand kit (logo, color, font) applied to video
- Figma file as input source
- Multiple video format exports (square, vertical for social)
- Version history per project (revert to earlier video)
- Team collaboration (shared projects, comments)
- Template library (e.g., "Product Hunt launch demo", "Investor pitch demo", "Feature announcement")
- Analytics on shared videos (views, watch time, drop-off)
- Direct integrations: Notion, Linear, Webflow, HubSpot
- White-label option for agencies

---

## User Experience Principles

**1. Always show progress, never show a spinner alone**
The user should always know what the AI is doing. Every agent action surfaces as a readable update in chat. "Analyzing your dashboard UI" is infinitely better than a loading bar with no context.

**2. Preserve human agency**
The AI does the heavy lifting, but the user is always the director. The agent asks for confirmation at key decision points. The user can intervene, redirect, or override at any moment.

**3. Iterate fast, not from scratch**
Changing one scene should not require regenerating the whole video. The system is designed around surgical, targeted iteration — like editing a document, not re-recording everything.

**4. The chat is the product**
Unlike tools where chat is a secondary feature, in Demio the chat interface is the primary control surface. Every meaningful action — adjusting pacing, changing a scene, adding a voiceover style — happens through natural conversation.

**5. Delight at every milestone**
Video creation has natural emotional peaks: when the script is approved, when the first scene renders, when the full video is ready. These moments should feel celebratory and satisfying, not just functional.

---

## Edge Cases & Constraints to Be Aware Of

- **Products behind authentication** — The Recording Agent cannot access gated product flows without credentials. The platform should gracefully handle this by prompting the user to either provide test credentials (stored securely and used only for recording) or upload their own screen recordings for those sections.
- **Products with heavy animations or complex WebGL UIs** — Some product UIs may not capture cleanly. The system should detect this and suggest static screenshot alternatives or ask the user to provide their own recording for that scene.
- **Very long or complex products** — If a product description is too broad ("demo everything"), the agent should push back and help the user narrow the scope to a specific user journey that fits within a 2–3 minute video.
- **Domain unavailability** — If the domain is unreachable or returns errors, the agent should notify the user and offer to proceed using only the provided description and any attached assets.
- **Model failures or timeouts** — If an agent step fails, the system should recover gracefully, retry where possible, and surface a clear explanation to the user with a manual retry option. It should never silently fail.

---

## Success Metrics (What "Working Well" Looks Like)

- A user can go from zero to a complete draft demo video in under 10 minutes
- Users iterate on average 2–3 times per project before downloading
- The video output requires no external editing before use
- Users return to create multiple projects (indicating the output quality justifies repeat use)
- The chat interaction feels natural enough that users don't need documentation to use it
