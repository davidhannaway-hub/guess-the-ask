// Is this photo the FRONT of a house? Runs CLIP (zero-shot) locally inside the GitHub job, so
// no extra service or key. Used by the picker: a house only goes into a game when one of its
// photos shows the front of the house, never a room, patio, roof terrace, deck, view, skyline,
// aerial shot, map, floor plan or mood board.
// Test: node scripts/photo-test.mjs (the Photo test workflow runs it on GitHub).
import { pipeline, env, RawImage } from '@huggingface/transformers';

env.cacheDir = process.env.HF_CACHE || '.cache/hf';
const MODEL = 'Xenova/clip-vit-base-patch32';

// Only the FRONT of the house counts (Dave, 18 Nov 2026). Patios, roof terraces, decks, balconies,
// back gardens, views, skylines and aerial shots are rejected even though they are "outside":
// at phone size a staged patio with sofas reads as a living room.
const OUTSIDE = [
  'a photo of the front of a house taken from outside',
  'a photo of a house exterior from the street',
  'a photo of the outside of a home with its roof and front door',
  'a photo of a terraced house from the street',
  'a photo of the front of a detached house with its front garden or driveway',
  'a photo of the front facade of a brick house',
  'a photo of the front of a brick row house or townhouse from the street',
];
const NOT = [
  'a photo of a living room', 'a photo of a kitchen', 'a photo of a bedroom', 'a photo of a bathroom',
  'a photo of a dining room', 'a photo of an empty room inside a house', 'a photo of a hallway and stairs',
  'a photo of a home office', 'a photo of a basement', 'a photo of a garage interior',
  'a floor plan', 'a map', 'a satellite map with property lines', 'a mood board of building materials and fixtures', 'a company logo or advert',
  'a photo of a swimming pool', 'a photo of an empty garden with no house', 'a photo of a view of the sea or countryside',
  'a photo of an apartment block', 'a photo of a street with no house in focus',
  'a photo of a patio with outdoor sofas and chairs', 'a photo of a roof terrace with outdoor furniture',
  'a photo of a wooden deck or balcony', 'a photo of the view from a balcony or terrace',
  'a photo of a city skyline', 'an aerial photo of a neighbourhood', 'an aerial drone photo of a beach and houses',
  'a photo of a back garden', 'a photo of the back of a house from the garden',
];
export const THRESHOLD = 0.4;

let clf;
async function model() {
  clf ??= await pipeline('zero-shot-image-classification', MODEL, { dtype: 'q8' }).catch(() => pipeline('zero-shot-image-classification', MODEL));
  return clf;
}

// Share of the score that goes to "front of a house" labels (0 to 1).
export async function outsideScore(jpegBuffer) {
  return (await outsideDetail(jpegBuffer)).score;
}
// Same, plus the best-matching label (for logs and the photo test).
export async function outsideDetail(jpegBuffer) {
  const img = await RawImage.fromBlob(new Blob([jpegBuffer]));
  const res = await (await model())(img, [...OUTSIDE, ...NOT]);
  return { score: res.filter(r => OUTSIDE.includes(r.label)).reduce((a, r) => a + r.score, 0), label: res[0].label };
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
