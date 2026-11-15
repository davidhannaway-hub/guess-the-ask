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

// ---------- rentals: which listing photos are worth showing ----------
// Rentals are judged on the inside, so the rule is different from houses: a good photo is the outside
// of the building, a living room, kitchen, dining room, conservatory, garden or view. A bedroom,
// bathroom, bare wall, hallway, floor plan or logo is never shown.
const GOOD_ROOM = [
  'a professional photo of the front of a building taken from outside',
  'a photo of a period house exterior',
  'a photo of an apartment building exterior',
  'a photo of a bright spacious living room with a sofa',
  'a photo of a stylish living room',
  'a photo of a modern kitchen',
  'a photo of a dining room with a table',
  'a photo of a glass conservatory',
  'a photo of a garden behind a house',
  'a photo of the view from a window or balcony',
];
const BAD_ROOM = [
  'a photo of a bedroom with a bed', 'a photo of a bathroom with a toilet', 'a photo of a shower or bath',
  'a photo of an empty white wall', 'a photo of an empty room with nothing in it', 'a photo of a hallway or corridor',
  'a photo of stairs', 'a floor plan', 'a map', 'a company logo or advert', 'a dark blurry photo',
  'a photo of a car park', 'a photo of a washing machine or utility room', 'a close-up of an appliance or radiator',
  'a photo of a wardrobe', 'a photo of a gym or communal room',
];
export const ROOM_THRESHOLD = 0.5;
// Share of the score that goes to "worth showing" labels (0 to 1), plus the best-matching label.
export async function roomScore(jpegBuffer) {
  const img = await RawImage.fromBlob(new Blob([jpegBuffer]));
  const res = await (await model())(img, [...GOOD_ROOM, ...BAD_ROOM]);
  const good = res.filter(r => GOOD_ROOM.includes(r.label)).reduce((a, r) => a + r.score, 0);
  return { good, label: res[0].label };
}
