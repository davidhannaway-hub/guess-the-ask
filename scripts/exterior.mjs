// Is this photo the outside of a house? Runs CLIP (zero-shot) locally inside the GitHub job, so
// no extra service or key. Used by the picker: a house only goes into a game when one of its
// photos shows the house itself, never a living room, kitchen, patio, floor plan or mood board.
// Tested on 147 game photos: every interior scored 0.32 or less, every real exterior 0.42 or more.
import { pipeline, env, RawImage } from '@huggingface/transformers';

env.cacheDir = process.env.HF_CACHE || '.cache/hf';
const MODEL = 'Xenova/clip-vit-base-patch32';

const OUTSIDE = [
  'a photo of the front of a house taken from outside',
  'a photo of a house exterior from the street',
  'a photo of the outside of a home with its roof and front door',
  'an aerial photo of a house and its garden',
  'a photo of a terraced house from the street',
  'a photo of the back of a house from the garden',
];
const NOT = [
  'a photo of a living room', 'a photo of a kitchen', 'a photo of a bedroom', 'a photo of a bathroom',
  'a photo of a dining room', 'a photo of an empty room inside a house', 'a photo of a hallway and stairs',
  'a photo of a home office', 'a photo of a basement', 'a photo of a garage interior',
  'a floor plan', 'a map', 'a mood board of building materials and fixtures', 'a company logo or advert',
  'a photo of a swimming pool', 'a photo of an empty garden with no house', 'a photo of a view of the sea or countryside',
  'a photo of an apartment block', 'a photo of a street with no house in focus',
];
export const THRESHOLD = 0.4;

let clf;
async function model() {
  clf ??= await pipeline('zero-shot-image-classification', MODEL, { dtype: 'q8' }).catch(() => pipeline('zero-shot-image-classification', MODEL));
  return clf;
}

// Share of the score that goes to "outside of a house" labels (0 to 1).
export async function outsideScore(jpegBuffer) {
  const img = await RawImage.fromBlob(new Blob([jpegBuffer]));
  const res = await (await model())(img, [...OUTSIDE, ...NOT]);
  return res.filter(r => OUTSIDE.includes(r.label)).reduce((a, r) => a + r.score, 0);
}
