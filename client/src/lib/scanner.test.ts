import { describe, expect, it } from 'vitest';
import { DECODE_LONG_EDGE, decodeSize, isStationPayload, trackIsLive } from './scanner';

describe('decodeSize', () => {
  /**
   * THE DOWNSCALE IS NOT OPTIONAL. Full-resolution getImageData + decode is
   * 60-100 ms per frame on a mid-range Android; at 10 fps that is a hot phone
   * and a janky preview — and a janky preview is what makes a member believe
   * the scanner is broken and walk to the desk.
   */
  it('caps the long edge at 480px', () => {
    expect(decodeSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(decodeSize(1080, 1920)).toEqual({ width: 270, height: 480 });
    expect(decodeSize(1280, 720).width).toBe(DECODE_LONG_EDGE);
  });

  it('preserves aspect ratio', () => {
    const { width, height } = decodeSize(1600, 1200);
    expect(width / height).toBeCloseTo(4 / 3, 2);
  });

  /** A 320px camera through a 480px canvas is interpolation for no detail. */
  it('never upscales a small camera', () => {
    expect(decodeSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('returns zero before the video has any dimensions', () => {
    expect(decodeSize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it('never rounds a tiny frame down to zero', () => {
    expect(decodeSize(3, 1, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('isStationPayload', () => {
  /**
   * The camera sees whatever is in front of it — a poster, a product barcode,
   * a friend's boarding pass. Posting those spends the member's rate limit on
   * garbage and answers with a 400 they cannot act on.
   */
  it('accepts a real station payload at either slot width', () => {
    expect(isStationPayload('GOTS1.9F2K.59570000.4RTXK8B2QWY5H3PZ')).toBe(true);
    expect(isStationPayload('GOTS1.9F2K.595700000.4RTXK8B2QWY5H3PZ')).toBe(true);
  });

  it('normalises case and whitespace, as in-browser decoders emit them', () => {
    expect(isStationPayload('  gots1.9f2k.59570000.4rtxk8b2qwy5h3pz\n')).toBe(true);
  });

  it('ignores anything that is not ours', () => {
    for (const other of [
      'https://example.com',
      '4006381333931',
      'GOTS2.9F2K.59570000.4RTXK8B2QWY5H3PZ',
      'GOTS1.9F2K.59570000',
      '',
    ]) {
      expect(isStationPayload(other)).toBe(false);
    }
  });

  /**
   * Crockford base32 excludes I, L, O and U so they cannot be confused with
   * 1, 0 and V. A payload carrying one is not ours.
   */
  it('rejects the ambiguous characters the station alphabet excludes', () => {
    expect(isStationPayload('GOTS1.9I2K.59570000.4RTXK8B2QWY5H3PZ')).toBe(false);
    expect(isStationPayload('GOTS1.9O2K.59570000.4RTXK8B2QWY5H3PZ')).toBe(false);
  });
});

describe('trackIsLive', () => {
  const streamWith = (track: Partial<MediaStreamTrack> | null): MediaStream =>
    ({ getVideoTracks: () => (track === null ? [] : [track]) }) as unknown as MediaStream;

  it('is true for a live, unmuted track', () => {
    expect(trackIsLive(streamWith({ readyState: 'live', muted: false }))).toBe(true);
  });

  /**
   * iOS suspends a track when the tab is backgrounded and frequently returns
   * it muted or ended. Without this check a member who gets a notification
   * mid-scan comes back to a permanently black frame and no error.
   */
  it('is false for the states iOS returns after a background', () => {
    expect(trackIsLive(streamWith({ readyState: 'live', muted: true }))).toBe(false);
    expect(trackIsLive(streamWith({ readyState: 'ended', muted: false }))).toBe(false);
  });

  it('is false with no stream or no video track', () => {
    expect(trackIsLive(null)).toBe(false);
    expect(trackIsLive(streamWith(null))).toBe(false);
  });
});
