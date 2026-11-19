// The public half of the web-push key pair. It is public by design (browsers need it to subscribe), so it lives in the code.
// The private half is the Netlify environment variable VAPID_PRIVATE_KEY and is never committed.
export const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BJzHEK6uNMZ4w16QW7qO-LITuFsncDYVbvzRAuuqYjScdvXQQKSXHDXXI0oTTSjpf-hWh2W_C94ebU-bjLNtS_A';
export const SUBJECT = 'mailto:hello@guesstheask.com';
