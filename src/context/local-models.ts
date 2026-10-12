// Local models, run on the processor: sentence vectors, and a model that reads a message and a rule together.
// Optional: without the runtime or the model files, selection stays on words.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelsDir } from "../storage/paths.js";

// query / passage: what the model expects in front of each kind of text.
export const SENTENCE_MODEL = { id: "Xenova/multilingual-e5-small", query: "query: ", passage: "passage: " };
export const READING_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
// A long message is cut so the rule always fits in what the reading model reads.
const MESSAGE_HEAD = 1500;

const modelFile = (id: string) => join(modelsDir(), ...id.split("/"), "onnx", "model_quantized.onnx");

export function localModelsInstalled(): boolean {
  return existsSync(modelFile(SENTENCE_MODEL.id)) && existsSync(modelFile(READING_MODEL));
}

type Runtime = any;
let runtime: Promise<Runtime> | null = null, sentences: Promise<Runtime> | null = null, reader: Promise<{ tokenizer: Runtime; model: Runtime }> | null = null;

function load(download: boolean): Promise<Runtime> {
  // Not a dependency of the package: installed apart by those who want the local models.
  const name = "@huggingface/transformers";
  runtime ??= import(name).catch(() => { throw new Error(`the runtime is missing; install it with \`npm install -g ${name}\``); });
  return runtime.then(t => { t.env.cacheDir = modelsDir(); t.env.allowRemoteModels = download; return t; });
}

/** One normalized vector per text. */
export async function sentenceVectors(texts: string[], kind: "query" | "passage", download = false): Promise<Float32Array[]> {
  const t = await load(download);
  const extract = await (sentences ??= t.pipeline("feature-extraction", SENTENCE_MODEL.id, { dtype: "q8" }));
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map(text => SENTENCE_MODEL[kind] + text);
    const tensor = await extract(batch, { pooling: "mean", normalize: true });
    const dim = tensor.dims[1] as number, data = tensor.data as Float32Array;
    for (let j = 0; j < batch.length; j++) out.push(data.slice(j * dim, (j + 1) * dim));
  }
  return out;
}

/** How well each text answers the message, higher is better; the scores only compare within one call. */
export async function readingScores(message: string, texts: string[], download = false): Promise<number[]> {
  const t = await load(download);
  const { tokenizer, model } = await (reader ??= (async () => ({ tokenizer: await t.AutoTokenizer.from_pretrained(READING_MODEL), model: await t.AutoModelForSequenceClassification.from_pretrained(READING_MODEL, { dtype: "q8" }) }))());
  const head = message.length > MESSAGE_HEAD ? message.slice(0, MESSAGE_HEAD) : message, scores: number[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const { logits } = await model(tokenizer(batch.map(() => head), { text_pair: batch, padding: true, truncation: true, max_length: 512 }));
    scores.push(...(logits.tolist() as number[][]).map(row => row[0]));
  }
  return scores;
}

/** Downloads both models into the models folder. */
export async function installLocalModels(): Promise<string> {
  await sentenceVectors(["ready"], "query", true);
  await readingScores("ready", ["ready"], true);
  return modelsDir();
}
