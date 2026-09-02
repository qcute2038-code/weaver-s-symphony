import type { Segment } from "./script";
import { paralonKeys, pixazoKeys, pickKey } from "./keys.server";

const CHAT_URL = "https://paraloncloud.com/v1/chat/completions";
/** Free-tier model only — the Paralon keys carry no credits. */
const CHAT_MODEL = "qwen3.8-27b";
const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";

/**
 * Global art direction: dark, mysterious, cinematic. Every panel in every
 * export uses this exact string so the whole film shares one look.
 */
export const STYLE =
  "dark mysterious cinematic anime manga illustration, low-key moody lighting, deep shadows and pools of darkness, " +
  "muted desaturated palette of charcoal black, midnight blue, cold slate grey and dull ember orange, " +
  "single hard rim light carving the subject out of the gloom, heavy atmospheric haze, volumetric god rays through dust, " +
  "cel shading with dark gradients, bold clean ink lines, richly detailed painted backgrounds, ominous foreboding mood, " +
  "high quality dark anime key visual, night or dim interior lighting";

/** Non-negotiable tone lock, stated separately so it carries its own weight. */
export const DARK_TONE_LOCK =
  "MANDATORY TONE: dark, dim, shadow-heavy and mysterious. Overall image brightness is LOW. " +
  "No bright daylight, no sunny cheerful lighting, no white or pastel backgrounds, no washed-out highlights, " +
  "no flat even lighting — darkness and shadow must dominate the frame";

/**
 * Text is the single most common Flux artefact, so it gets its own hard block
 * that is injected at BOTH ends of the prompt.
 */
export const NO_TEXT_GUARD =
  "ABSOLUTELY NO TEXT ANYWHERE IN THE IMAGE: no letters, no words, no numbers, no digits, no captions, no subtitles, " +
  "no title card, no speech bubbles, no dialogue balloons, no thought bubbles, no onomatopoeia, no sound effects, " +
  "no signage, no shop signs, no street signs, no billboards, no posters, no banners, no newspaper, no book pages, " +
  "no labels, no tags, no handwriting, no calligraphy, no graffiti, no tattoos with writing, no screen text, no UI, " +
  "no watermark, no signature, no logo, no branding, no gibberish glyphs, no fake alphabets, no symbols resembling writing. " +
  "Every surface — walls, clothing, papers, screens, vehicles — is completely blank and free of writing";

/**
 * Hard guards that stop the model from drawing a character reference sheet,
 * a character portrait inset, or a split/collage layout next to the scene.
 */
export const SINGLE_PANEL_GUARD =
  "ONE single full-bleed illustration of this one moment only, one continuous scene, " +
  "no character reference sheet, no character lineup, no turnaround, no inset portrait, " +
  "no side panel, no split screen, no collage, no grid, no multiple panels, no borders, no frame, " +
  "no duplicated characters, no repeated figures, no extra copies of the same person, " +
  "ONLY the people explicitly named in this description, no extra people, no bystanders, no crowd, no background characters, " +
  "no animals of any kind, no cow, no cattle, no sheep, no goat, no horse, no dog, no cat, no birds, no butterflies, no livestock, no wildlife, " +
  "no invented props or creatures that are not described, " +
  "every named character must keep the exact gender stated in this prompt, no gender swapping, no feminized male characters, no masculinized female characters, " +
  "not empty, not a blank canvas, not a solid colour fill, not an abstract texture — a fully drawn detailed scene with a clear subject";

export async function zaiChat(
  messages: { role: string; content: string }[],
  opts: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    attempts?: number;
    /** Scene/batch index — spreads concurrent calls over the key pool. */
    slot?: number;
  } = {},
): Promise<string> {
  const keys = paralonKeys();
  const slot = opts.slot ?? 0;

  const attempts = opts.attempts ?? 3;
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Free model only: the keys hold zero credits, so never fall back
          // to a paid model.
          model: opts.model ?? CHAT_MODEL,
          temperature: opts.temperature ?? 0.6,
          // Disable Qwen3 thinking/reasoning mode so the model answers directly
          // and returns much faster. vLLM reads it from chat_template_kwargs;
          // the flat flag is kept for gateways that look at the top level.
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: opts.maxTokens ?? 4000,
          messages,
        }),
      });
      if (!res.ok) {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        // 401/403 = bad key, 400 = the request itself (usually too long) — both
        // are pointless to retry on the same payload.
        if (res.status === 400 || res.status === 401 || res.status === 403) break;
        // free tier is 60 req/min per key: wait out the window on another key
        if (res.status === 429 && attempt < attempts - 1) {
          await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
          continue;
        }
      } else {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning?: string } }[];
        };
        const msg = json.choices?.[0]?.message;
        const text = msg?.content?.trim() || extractFromReasoning(msg?.reasoning);
        if (text) return text;
        lastErr = "empty completion";
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // 502/504 come from the provider's edge (HTML body), not the model:
    // back off progressively instead of failing the whole batch.
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  throw new Error(`Text model request failed: ${lastErr}`);
}

/** Last-resort salvage: pull a JSON array out of truncated reasoning text. */
function extractFromReasoning(reasoning?: string): string | null {
  if (!reasoning) return null;
  const start = reasoning.indexOf("[");
  const end = reasoning.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const slice = reasoning.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return Array.isArray(parsed) ? slice : null;
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

export function parseJsonArray(raw: string): unknown[] {
  const text = stripFences(raw);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Model did not return a JSON array");
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are a manga art director for a DARK, mysterious, noir-toned anime film. Read the script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 14-25 words per character. Max 6 characters. " +
    "You are given only the OPENING of the script; that is enough — do not ask for more. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary. Do not deliberate — answer immediately.";

  // head-only sample, cut on a line boundary so the model never sees half a word
  const sampleAt = (budget: number) => {
    if (script.length <= budget) return script;
    const head = script.slice(0, budget);
    const cut = head.lastIndexOf("\n");
    return cut > budget * 0.5 ? head.slice(0, cut) : head;
  };

  let lastErr = "";
  // shrink on every failure: context overflow is the usual cause for long scripts
  for (const [i, budget] of [6000, 4000, 2500, 1200].entries()) {
    try {
      const out = await zaiChat(
        [
          { role: "system", content: system },
          { role: "user", content: `SCRIPT OPENING:\n${sampleAt(budget)}` },
        ],
        { maxTokens: 1200, timeoutMs: 90_000, attempts: 2, slot: i },
      );
      const bible = stripFences(out).slice(0, 2400);
      if (bible.length > 20) return bible;
      lastErr = "empty bible";

    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("buildCharacterBible failed, continuing without a bible:", lastErr);
  return "";
}


const PROMPT_SYSTEM =
  "You write image prompts for a DARK, mysterious, cinematic manga storyboard. Input: a character bible, optional story " +
  "context, and numbered script lines (Hindi/Hinglish). For EACH numbered line write ONE English image prompt describing a " +
  "SINGLE cinematic moment from that line.\n" +
  "EVERY prompt must contain, in this order: (1) who is in frame with their bible traits woven inline, (2) their exact " +
  "action and facial expression, (3) the specific setting with 2-3 concrete environmental details taken from the script " +
  "line, (4) the camera angle and shot size (extreme close-up / close-up / medium / wide / low angle / over-the-shoulder / " +
  "Dutch tilt), (5) the DARK lighting description (e.g. 'single bare bulb throwing hard shadows', 'blue moonlight through " +
  "a barred window', 'dull ember glow in thick darkness').\n" +
  "RULES:\n" +
  "- FAITHFUL DETAIL (critical): the prompt must capture the specific things that line actually says — the object, the " +
  "place, the gesture, the emotion, the weather, the time of day. Never write a generic 'a boy stands thinking' prompt. " +
  "Do not skip story details; if the line has several details, include the most visual ones.\n" +
  "- TONE (mandatory): every image is dark, dim, shadow-heavy, moody and mysterious. Use night, dusk, storm, dim " +
  "interiors, single light sources, deep shadow. NEVER describe bright sunny daylight, cheerful light, white backgrounds " +
  "or flat even lighting. Even a daytime line must be overcast, gloomy and desaturated.\n" +
  "- Weave a character's fixed traits INLINE into the sentence (e.g. 'Henan, a thin 17-year-old boy with messy jet-black " +
  "hair, sits...'). NEVER write a separate character description block, character sheet, reference, lineup, or 'plus portrait of'.\n" +
  "- CONSISTENCY: repeat a character's bible traits (hair, eyes, clothing colours) in EVERY prompt they appear in, using " +
  "the same words as the bible. Never redesign, re-age or re-dress a character between shots.\n" +
  "- GENDER ACCURACY (critical): every main character from the bible MUST be written with their name AND their exact " +
  "gender from the bible, using an explicit gendered noun — e.g. 'Henan, a male 17-year-old boy...' or 'Priya, a female " +
  "14-year-old girl...'. Never refer to a main character as just 'a man', 'a woman', 'a person', 'he' or 'she' without the " +
  "name. NEVER change, swap or reverse any character's gender. For side characters not in the bible, pick one gender from " +
  "the script context and state it explicitly (e.g. 'a female boss in her 40s, dark business suit').\n" +
  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets, collages or " +
  "side-by-side views.\n" +
  "- CAST FIDELITY: include ONLY the people that specific script line mentions. If a line mentions only Henan, the prompt " +
  "must contain Henan ALONE. Never assume two characters are together unless the line says so.\n" +
  "- SIDE CHARACTERS: if the line mentions someone NOT in the bible (a boss, teacher, shopkeeper), invent a short distinct " +
  "visual for them inline (age, gender, one clothing detail). NEVER substitute a main character's name or traits.\n" +
  "- STRICT FIDELITY: describe ONLY what the script line actually says. Never invent people, animals (cows, sheep, goats, " +
  "dogs, cats, birds), vehicles or crowds the line does not mention. If the line names no location, keep the background a " +
  "simple dark neutral space.\n" +
  "- NO TEXT: never describe text, letters, words, numbers, signs, signboards, posters, banners, newspapers, book pages, " +
  "screens with writing, labels or logos. If the script mentions something written, show the OBJECT and the character's " +
  "reaction instead, never the writing itself.\n" +
  "- 55 to 85 words each. English only. No numbering inside the string.\n" +
  "- Do not deliberate or explain. Output the JSON array immediately.\n" +
  'Return ONLY a JSON array of strings, one per numbered line, in order.';

/**
 * Writes one image prompt per segment, in batches.
 *
 * `context` carries the couple of script lines immediately before this batch so
 * the model knows where the scene is and who is present — that continuity is
 * what stops panels from losing story detail at batch boundaries.
 */
export async function writePrompts(
  bible: string,
  segments: Segment[],
  slot = 0,
  context = "",
): Promise<string[]> {
  const numbered = segments.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");

  const ask = async (segs: Segment[], lines: string, s: number, temp: number) =>
    zaiChat(
      [
        { role: "system", content: PROMPT_SYSTEM },
        {
          role: "user",
          content:
            `CHARACTER BIBLE:\n${bible}\n\n` +
            (context ? `STORY SO FAR (context only — do NOT storyboard these):\n${context}\n\n` : "") +
            `SCRIPT LINES:\n${lines}\n\nReturn a JSON array with exactly ${segs.length} prompt strings.`,
        },
      ],
      {
        temperature: temp,
        maxTokens: 500 + segs.length * 320,
        // Small batches answer in a few seconds; a call that hangs longer is
        // stuck, so fail over to another key instead of blocking the wave.
        timeoutMs: 60_000,
        attempts: 3,
        slot: s,
      },
    );

  let arr: unknown[] = [];
  try {
    arr = parseJsonArray(await ask(segments, numbered, slot, 0.7));
  } catch (e) {
    console.error("writePrompts first pass failed:", e instanceof Error ? e.message : e);
    arr = [];
  }

  const usable = (v: unknown) => typeof v === "string" && v.trim().length > 30;

  // Repair pass: one timestamp must always get its own prompt, so anything the
  // first pass dropped or truncated is asked for again on a different key.
  const missing = segments.map((_, i) => i).filter((i) => !usable(arr[i]));
  if (missing.length > 0) {
    try {
      const subset = missing.map((i) => segments[i]!);
      const lines = subset.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
      const fixed = parseJsonArray(await ask(subset, lines, slot + 1, 0.5));
      missing.forEach((segIdx, k) => {
        if (usable(fixed[k])) arr[segIdx] = fixed[k];
      });
    } catch (e) {
      console.error("writePrompts repair failed:", e instanceof Error ? e.message : e);
    }
  }

  return segments.map((s, i) => {
    const v = arr[i];
    const text = usable(v) ? (v as string).trim() : null;
    return sanitizePrompt(text ?? fallbackPrompt(s));
  });
}

function fallbackPrompt(s: Segment): string {
  return (
    "A single dark cinematic manga scene, dim moody low-key lighting with deep shadows, depicting this exact story " +
    `moment: ${s.text}`
  );
}

/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [/\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi, "weathered wall"],
  [/\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi, "bare wall"],
  [/\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b/gi, "worn paper object"],
  [/\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi, ""],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [/\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi, "dark glowing screen"],
  [/"[^"]{0,120}"/g, ""],
  [/'[^']{2,120}'/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/** Bright-light phrasing that would break the mandatory dark tone. */
const BRIGHT_TRIGGERS: [RegExp, string][] = [
  [/\b(bright|brightly|blinding|dazzling)\s+(sunlight|sunshine|daylight|light|lighting|sun)\b/gi, "dim shadowy light"],
  [/\b(bright sunny|sunny|sunlit|sun-drenched|sun drenched)\b/gi, "overcast gloomy"],
  [/\b(bright|brightly lit|well[- ]lit|cheerful|cheery|vibrant|radiant|glowing warmly|airy)\b/gi, "dim"],
  [/\b(white|pale|pastel|clean white)\s+background\b/gi, "dark shadowy background"],
  [/\b(midday sun|noon sun|clear blue sky|bright blue sky|golden sunlight)\b/gi, "heavy grey overcast sky"],
  [/\b(flat even lighting|even lighting|soft daylight|daylight)\b/gi, "low-key shadowed lighting"],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or bright light. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "dark full colour",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of BRIGHT_TRIGGERS) out = out.replace(re, to);
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 6);
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Stamp the gender next to each name so the renderer cannot misread it.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male" : "female";
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\))`, "g"),
      `${e.name} (${noun})`,
    );
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  const matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  // Only lock characters actually present in this scene — never inject
  // the whole cast into a prompt that doesn't mention them.
  if (matched.length === 0) return "";
  return (
    "Fixed character appearance and GENDER (must match exactly, never swap or change gender or clothing): " +
    matched
      .map((e) => {
        const g = genderOf(e.traits);
        const traits = e.traits.replace(/\.$/, "");
        return g ? `${e.name} is ${g.toUpperCase()} — ${traits}` : `${e.name} is ${traits}`;
      })
      .join("; ") +
    "."
  );
}

export function composeImagePrompt(prompt: string, bible?: string): string {
  const fixed = enforceGender(sanitizePrompt(prompt), bible);
  const lock = characterLock(fixed, bible);
  // The gender lock goes FIRST: the earliest tokens carry the most weight in
  // Flux, which is exactly where character identity has to be pinned. The text
  // ban is repeated at both ends because that artefact is the most persistent.
  return (
    `${NO_TEXT_GUARD}. ${lock ? lock + " " : ""}${STYLE}. ${fixed}. ` +
    `${DARK_TONE_LOCK}. ${SINGLE_PANEL_GUARD}. ${NO_TEXT_GUARD}. 16:9 widescreen cinematic framing.`
  );
}

/**
 * Blank-panel rejection.
 *
 * A blank/solid or nearly-empty Flux frame compresses to a few kilobytes and
 * its compressed bytes carry very little entropy, while a real detailed
 * 1024x576 panel never does. Anything suspiciously small, low-entropy, or not
 * an image at all is treated as blank and re-rendered on another key/seed, so
 * no empty panel can reach the encoder.
 */
const MIN_IMAGE_BYTES = 40_000;
/** Shannon entropy (bits/byte) of compressed image data; real art is > 7.5. */
const MIN_ENTROPY = 7.0;

function byteEntropy(buf: Uint8Array): number {
  const counts = new Uint32Array(256);
  const step = Math.max(1, Math.floor(buf.byteLength / 200_000));
  let n = 0;
  for (let i = 0; i < buf.byteLength; i += step) {
    counts[buf[i]!] = counts[buf[i]!]! + 1;
    n++;
  }
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (!c) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

async function isRealImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < MIN_IMAGE_BYTES) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45;
    if (!isPng && !isJpg && !isWebp) return false;
    // skip the header before measuring entropy of the compressed payload
    return byteEntropy(buf.subarray(Math.min(2048, buf.byteLength >> 2))) >= MIN_ENTROPY;
  } catch {
    // Network hiccup while probing: don't throw away a probably-good panel.
    return true;
  }
}


/** Calls Flux.1 Schnell (free tier) with automatic retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
): Promise<string> {
  const keys = pixazoKeys();
  const body = composeImagePrompt(prompt, bible).slice(0, 1900);

  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(PIXAZO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": key,
        },
        body: JSON.stringify({
          prompt: body,
          num_steps: 4,
          // a fresh seed each attempt, so a blank frame is never re-rolled identically
          seed: seed + attempt * 977,
          width: 1024,
          height: 576,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { output?: string };
        if (json.output) {
          if (await isRealImage(json.output)) return json.output;
          lastErr = "blank image rejected";
        } else {
          lastErr = "no output url";
        }
      } else {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}
