'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  cameraSupported,
  createDecoder,
  isStationPayload,
  trackIsLive,
  type QrDecoder,
  type ScannerState,
} from '@/lib/scanner';

interface CheckInScannerProps {
  /** Called once per accepted payload. The parent owns the request. */
  onPayload: (payload: string) => void;
  /** Freezes the loop and releases the camera while a request is in flight. */
  paused: boolean;
  /** Announced to a screen reader the instant a code is read. */
  onDecodeAnnounce?: () => void;
}

/**
 * Whether this device has already granted camera access.
 *
 * `navigator.permissions.query({ name: 'camera' })` is Chromium-only — SAFARI
 * REJECTS IT — so the portable signal is "it worked here before". With the
 * flag set the camera opens on mount and `Scan again` is genuinely one tap;
 * without it the member taps once to grant, which is the correct and expected
 * flow for a first visit.
 *
 * Deliberately NOT in `MEMBER_DEVICE_CACHE_KEYS`: it records a fact about the
 * DEVICE, not about the member, so it says nothing that would leak on a shared
 * or resold phone and is not something `signOut` should clear.
 */
const CAMERA_GRANTED_KEY = 'got.device.cameraGranted';

/**
 * The member's camera.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR THINGS HERE ARE PLATFORM WORKAROUNDS, NOT PREFERENCES. Each one is a
 * black frame or a dead scanner on a real handset if it is removed.
 *
 * 1. `video.play()` IS CALLED AND AWAITED EXPLICITLY. On iOS a MediaStream
 *    does not start from assigning `srcObject` alone, and `playsInline` +
 *    `muted` are not sufficient. A rejected promise becomes `BLOCKED` with a
 *    "try again" affordance, never a black rectangle.
 *
 * 2. `facingMode: { ideal: 'environment' }`, NEVER `exact`. `exact` THROWS on
 *    any device with only a front camera, and a thrown constraint is a member
 *    who cannot check in at all.
 *
 * 3. ON RESUME THE TRACK IS REVALIDATED. iOS suspends the track when the tab
 *    is backgrounded and frequently hands it back `muted` or `ended`; without
 *    the assertion a member who gets a notification mid-scan returns to a
 *    permanently black frame and no error. If it fails, the stream is torn
 *    down and re-acquired.
 *
 * 4. `requestVideoFrameCallback` WHERE AVAILABLE — it fires once per decoded
 *    frame, so no work is wasted decoding the same picture twice. The
 *    `setTimeout` fallback is throttled to ~10 fps for the same reason.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DISPLAYED STATE IS DERIVED, not stored twice. Capability and pause both
 * override the machine's own state rather than writing to it — two sources of
 * truth for "what is on screen" is how a scanner ends up showing a live
 * reticle over a stopped camera.
 */
export function CheckInScanner({ onPayload, paused, onDecodeAnnounce }: CheckInScannerProps) {
  const [state, setState] = useState<ScannerState>('PRIMED');
  const [decoderKind, setDecoderKind] = useState<QrDecoder['kind'] | null>(null);

  // Read as an external capability rather than copied into state by an
  // effect: `navigator` does not exist during server rendering, and an effect
  // would paint one wrong frame — here, an "Open camera" button on a device
  // that has no camera API at all.
  const supported = useSyncExternalStore(subscribeNever, cameraSupported, () => true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<QrDecoder | null>(null);
  const onPayloadRef = useRef(onPayload);
  const onAnnounceRef = useRef(onDecodeAnnounce);
  const runningRef = useRef(false);

  useEffect(() => {
    onPayloadRef.current = onPayload;
    onAnnounceRef.current = onDecodeAnnounce;
  }, [onPayload, onDecodeAnnounce]);

  const stop = useCallback(() => {
    runningRef.current = false;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  const loop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const decoder = decoderRef.current;
    if (video === null || canvas === null || decoder === null) return;

    const tick = async (): Promise<void> => {
      if (!runningRef.current) return;

      try {
        const value = await decoder.decode(video, canvas);
        if (value !== null && isStationPayload(value)) {
          // The camera sees whatever is in front of it — a poster, a product
          // barcode, a friend's boarding pass. Anything that is not one of our
          // codes is ignored and the loop keeps going, which is what a member
          // expects when something drifts through frame.
          runningRef.current = false;
          onAnnounceRef.current?.();
          onPayloadRef.current(value.trim().toUpperCase());
          return;
        }
      } catch {
        // A single bad frame — a rotation, a track hiccup. Keep scanning: a
        // loop that gives up on one exception dies the first time the member
        // turns the phone.
      }

      schedule();
    };

    const schedule = (): void => {
      if (!runningRef.current) return;
      const withFrameCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (withFrameCallback.requestVideoFrameCallback !== undefined) {
        withFrameCallback.requestVideoFrameCallback(() => void tick());
      } else {
        // ~10 fps. Faster buys nothing — a member cannot hold a phone steadily
        // enough for consecutive frames to differ usefully — and costs heat.
        window.setTimeout(() => void tick(), 100);
      }
    };

    schedule();
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!cameraSupported()) return;

    setState('BOOTING');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // ASK FOR RESOLUTION. Without a hint some Android devices hand back
          // 640x480, and a 25-module symbol read across a metre of lobby
          // occupies too few pixels per module to decode — the scanner "just
          // does not work" on those handsets and works everywhere it is
          // tested. `ideal` rather than `exact` so a camera that cannot manage
          // it degrades instead of failing to open at all.
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (video === null) return;
      video.srcObject = stream;

      // EXPLICIT and AWAITED. iOS will not start the stream otherwise.
      await video.play();

      decoderRef.current ??= await createDecoder();
      setDecoderKind(decoderRef.current.kind);
      window.localStorage.setItem(CAMERA_GRANTED_KEY, '1');

      runningRef.current = true;
      setState('ARMED');
      loop();
    } catch {
      stop();
      setState('BLOCKED');
    }
  }, [loop, stop]);

  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Auto-arm when this device has granted the camera before. Deferred by a
  // tick so the effect never sets state during its own commit.
  useEffect(() => {
    if (paused || !supported) return;
    if (window.localStorage.getItem(CAMERA_GRANTED_KEY) !== '1') return;

    const id = window.setTimeout(() => void startRef.current(), 0);
    return () => window.clearTimeout(id);
  }, [paused, supported]);

  // Pause on background, and REVALIDATE on return.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        runningRef.current = false;
        return;
      }
      if (state !== 'ARMED') return;

      if (trackIsLive(streamRef.current)) {
        runningRef.current = true;
        loop();
      } else {
        // iOS handed the track back dead. Re-acquire rather than leave a black
        // frame that a member reads as a broken scanner.
        stop();
        void startRef.current();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [state, loop, stop]);

  // A camera running behind a verdict is a hot phone and a lit privacy
  // indicator on a screen that is no longer scanning.
  useEffect(() => {
    if (paused) stop();
  }, [paused, stop]);

  useEffect(() => stop, [stop]);

  const shown: ScannerState = !supported ? 'UNAVAILABLE' : paused ? 'BOOTING' : state;

  return (
    <div className="ci-scanner">
      <video
        ref={videoRef}
        className="ci-video"
        playsInline
        muted
        // Never `autoPlay`: the stream starts from an explicit awaited play(),
        // which is the only thing iOS accepts.
        data-armed={shown === 'ARMED'}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} aria-hidden />

      {shown === 'ARMED' ? (
        <div className="ci-reticle" aria-hidden />
      ) : (
        <div className="ci-overlay">
          {shown === 'UNAVAILABLE' ? (
            <>
              <p className="ci-overlay-title">Camera unavailable</p>
              {/* `navigator.mediaDevices` is undefined on a non-secure origin.
                  localhost is exempt; http://192.168.x.x on a real handset is
                  NOT, and that is exactly how this gets tested first. */}
              <p className="ci-overlay-body">
                This page needs a secure connection to use the camera. Show your member code at the
                desk instead.
              </p>
            </>
          ) : shown === 'BLOCKED' ? (
            <>
              <p className="ci-overlay-title">Camera is off</p>
              <p className="ci-overlay-body">
                Allow camera access in your browser, then tap below. The desk can also check you in.
              </p>
              <button type="button" className="p-btn p-btn-gold" onClick={() => void start()}>
                Try again
              </button>
            </>
          ) : shown === 'BOOTING' ? (
            <p className="ci-overlay-body">Starting the camera…</p>
          ) : (
            <>
              <p className="ci-overlay-title">Scan the desk code</p>
              <p className="ci-overlay-body">Point your camera at the screen on the counter.</p>
              <button
                type="button"
                className="p-btn p-btn-gold"
                // Pre-warmed on pointerdown rather than click: on iOS that
                // recovers ~150 ms of the tap, which is the difference between
                // "instant" and "did it register".
                onPointerDown={() => void start()}
                onClick={() => void start()}
              >
                Open camera
              </button>
            </>
          )}
        </div>
      )}

      {decoderKind !== null && shown === 'ARMED' ? (
        <span className="ci-decoder" aria-hidden>
          {decoderKind === 'native' ? 'fast scan' : 'scanning'}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Camera support cannot change for the lifetime of a document, so there is
 * nothing to subscribe to — but `useSyncExternalStore` is still the right
 * shape: it reads a value that does not exist on the server without painting
 * a wrong first frame on the client.
 */
function subscribeNever(): () => void {
  return () => {};
}
