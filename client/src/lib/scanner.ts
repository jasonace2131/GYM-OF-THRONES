'use client';

import { STATION_TOKEN_REGEX } from '@got/shared';

/**
 * The camera scanner's decode strategy and its arithmetic — the parts that can
 * be reasoned about without a camera.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO DECODERS, AND THE FALLBACK IS THE PRIMARY PATH FOR HALF THE MEMBERS.
 *
 * `BarcodeDetector` is hardware-accelerated and markedly better in low light,
 * but it exists only in Chromium — Safari and Firefox have nothing. On an iOS
 * handset, `jsQR` IS the scanner. It is not an edge case and it is not a
 * degraded mode: it is what roughly half the member base runs every visit, and
 * it should be tested first, on the oldest phone available.
 *
 * `jsQR` is `await import()`-ed only when `BarcodeDetector` is missing, so
 * Android members never download it.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** What both decoders reduce to. */
export interface QrDecoder {
  /** The decoded text, or null for "nothing in this frame". */
  decode(source: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null>;
  readonly kind: 'native' | 'jsqr';
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

interface BarcodeDetectorCtor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

/**
 * Feature-detect the CONSTRUCTOR **and** the format.
 *
 * `'BarcodeDetector' in window` alone is not enough: some builds expose the
 * constructor while supporting only linear formats, and a detector that never
 * finds a QR is indistinguishable from a member holding the phone wrong.
 */
export async function createDecoder(): Promise<QrDecoder> {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

  if (ctor !== undefined) {
    try {
      const formats = await ctor.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new ctor({ formats: ['qr_code'] });
        return {
          kind: 'native',
          decode: async (source) => {
            const found = await detector.detect(source);
            return found[0]?.rawValue ?? null;
          },
        };
      }
    } catch {
      // A constructor that throws on this device. Fall through to jsQR rather
      // than leaving the member with a camera that decodes nothing.
    }
  }

  const { default: jsQR } = await import('jsqr');
  return {
    kind: 'jsqr',
    decode: async (source, canvas) => {
      const frame = drawDownscaled(source, canvas);
      if (frame === null) return null;
      const result = jsQR(frame.data, frame.width, frame.height, {
        // The station symbol is black on white and never inverted; trying both
        // doubles the per-frame cost for a case that cannot occur.
        inversionAttempts: 'dontInvert',
      });
      return result?.data ?? null;
    },
  };
}

/**
 * The longest edge handed to jsQR.
 *
 * THE DOWNSCALE IS NOT OPTIONAL. A full-resolution `getImageData` plus decode
 * is 60-100 ms per frame on a mid-range Android; at 10 fps that is a hot phone
 * and a visibly janky preview — and a janky preview is what makes a member
 * believe the scanner is broken and walk to the desk.
 */
export const DECODE_LONG_EDGE = 480;

/** The downscaled frame size for a given video, preserving aspect ratio. */
export function decodeSize(
  videoWidth: number,
  videoHeight: number,
  longEdge = DECODE_LONG_EDGE,
): { width: number; height: number } {
  const longest = Math.max(videoWidth, videoHeight);
  if (longest === 0) return { width: 0, height: 0 };

  // Never UPSCALE. A 320px camera fed through a 480px canvas costs
  // interpolation on every frame and adds no detail for the decoder.
  const scale = Math.min(1, longEdge / longest);
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

function drawDownscaled(video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null {
  const { width, height } = decodeSize(video.videoWidth, video.videoHeight);
  if (width === 0 || height === 0) return null;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // `willReadFrequently` moves the canvas to a software backing store, which
  // is what this loop actually wants: every frame is read straight back out,
  // and a GPU-backed canvas pays a full pipeline stall on each read.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;

  context.drawImage(video, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * Is this string one of OUR station codes?
 *
 * The camera sees whatever is in front of it — a poster, a product barcode, a
 * friend's boarding pass. Posting those to `/checkin` would spend the member's
 * rate limit on garbage and answer with a 400 they cannot act on. Checking the
 * shape here means an unrelated code is simply ignored and the loop keeps
 * scanning, which is what a member expects.
 */
export function isStationPayload(value: string): boolean {
  return STATION_TOKEN_REGEX.test(value.trim().toUpperCase());
}

/**
 * The scanner's states. `BLOCKED` is separate from `DENIED` on purpose: one is
 * a browser permission the member can fix, the other is a decision about their
 * membership, and collapsing them produces a screen that tells someone to see
 * the desk when they only needed to tap "allow".
 */
export type ScannerState =
  /** Waiting for the member to arm the camera. */
  | 'PRIMED'
  /** getUserMedia in flight. */
  | 'BOOTING'
  /** Decoding frames. */
  | 'ARMED'
  /** A code was read; the request is in flight. */
  | 'SUBMITTING'
  /** The verdict is on screen. */
  | 'RESULT'
  /** Camera permission refused, or `play()` rejected. */
  | 'BLOCKED'
  /** No camera API at all — almost always a non-secure origin. */
  | 'UNAVAILABLE';

/**
 * `navigator.mediaDevices` is `undefined` on a non-secure origin.
 *
 * `localhost` is exempt; **`http://192.168.1.x:3000` on a real handset is
 * not** — and that is the exact configuration in which this feature gets
 * tested first. Detecting it here turns an afternoon of confusion into one
 * sentence on screen.
 */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
}

/**
 * Is the track still usable after the tab came back?
 *
 * iOS suspends a MediaStream track when the tab is backgrounded and frequently
 * returns it `muted` or `ended`. Without this assertion a member who gets a
 * notification mid-scan comes back to a permanently black frame and no error —
 * they conclude the scanner is broken, and they are not wrong.
 */
export function trackIsLive(stream: MediaStream | null): boolean {
  const track = stream?.getVideoTracks()[0];
  return track !== undefined && track.readyState === 'live' && !track.muted;
}

/**
 * Retry backoff for the check-in POST: 200 ms then 800 ms, then stop.
 *
 * Two retries INSIDE the token's own validity window. This covers a flaky
 * connection, which is the common case; it does not pretend to cover an absent
 * one, and it deliberately does not queue — a queued station token is a token
 * that has EXPIRED by the time it flushes, and accepting a stale one would
 * widen the relay window from a minute to the queue's TTL.
 */
export const SUBMIT_BACKOFF_MS = [200, 800] as const;
