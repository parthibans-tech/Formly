"use client";

// Camera-capture modal used by /drive's "Capture image" entry point.
//
// Flow:
//   1. Open dialog → request getUserMedia (back camera preferred on
//      mobile via facingMode: 'environment'), pipe into a <video>.
//   2. User clicks Capture → draw the current frame to an offscreen
//      <canvas>, encode to JPEG via canvas.toBlob, show as still preview.
//   3. User clicks "Use photo" → wrap the Blob into a File and hand it
//      to the parent (`onCapture`). Parent owns the upload pipeline.
//   4. User clicks "Retake" → discard the preview, resume streaming.
//   5. On close (any path) → release the MediaStream so the OS-level
//      camera indicator turns off promptly. Browsers don't always
//      garbage-collect tracks fast enough; explicit stop() is the only
//      reliable signal to the platform.
//
// Why JPEG (not PNG):
//   Photos compress an order of magnitude smaller as JPEG and the
//   storage policy size cap doesn't care about lossless. A 1080p PNG
//   capture often lands at 4–8 MiB; the same frame as JPEG q=0.92 is
//   ~250–500 KiB — same visual fidelity for upload purposes.
//
// Why we don't use <input type="file" accept="image/*" capture>:
//   That works on phones but on desktop just opens the file picker —
//   no live preview, no retake, and on iOS Safari it sometimes ignores
//   the `capture` hint and goes to the gallery. A real getUserMedia
//   modal gives a consistent UX across desktop + mobile.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, SwitchCamera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Phase = "idle" | "starting" | "streaming" | "preview" | "error";

export function CameraCaptureDialog({
  open,
  onOpenChange,
  onCapture,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Called once with the encoded JPEG. Parent owns the upload — we
  // don't reach into the drive's upload() here so this component stays
  // re-usable from anywhere a File is needed.
  onCapture: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // Captured still as a data URL so the preview <img> can render
  // without a blob URL juggle. The actual File handed to onCapture is
  // built from the source Blob, not from the data URL.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  // Front vs back camera. Phones almost always have both; desktops
  // usually one. We start on 'environment' (back) since the most
  // common drive use-case is "snap a document"; the toggle button
  // appears only when a flip might actually do something.
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  // releaseStream is the single chokepoint that stops the camera. Both
  // close-paths and remounts go through it so the OS indicator clears
  // promptly.
  const releaseStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      // Detach the srcObject so React doesn't keep a dangling reference
      // that would prevent the GC from cleaning up the stream.
      videoRef.current.srcObject = null;
    }
  }, []);

  const startStream = useCallback(
    async (which: "environment" | "user") => {
      setError(null);
      setPhase("starting");
      // Tear down any existing stream first — happens when the user
      // toggles facing mode while a stream is already live.
      releaseStream();
      try {
        if (
          typeof navigator === "undefined" ||
          !navigator.mediaDevices?.getUserMedia
        ) {
          throw new Error(
            "Your browser doesn't support camera capture. Try a recent Chrome, Firefox, or Safari.",
          );
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: which },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Some browsers require an explicit play() after srcObject
          // is set even though the element has autoPlay.
          await videoRef.current.play().catch(() => {
            // Play can reject in iOS when the gesture chain is broken;
            // the autoPlay attribute usually still kicks in. Silently
            // tolerate — if the video really doesn't render we'll see
            // it as a blank surface and the user will close.
          });
        }
        setPhase("streaming");
      } catch (e: any) {
        // Map the common DOMException names to plain-language copy.
        // The default message ("Permission denied") doesn't tell the
        // user how to recover; ours points at the address-bar lock.
        let msg = e?.message || "Couldn't start the camera.";
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
          msg =
            "Camera access was blocked. Click the camera icon in your address bar to allow it, then try again.";
        } else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
          msg =
            "No camera was found on this device. If you have one connected, make sure no other app (Zoom, Teams) is using it.";
        } else if (e?.name === "NotReadableError") {
          msg =
            "Your camera is busy. Close any other tab or app that might be using it and try again.";
        }
        setError(msg);
        setPhase("error");
      }
    },
    [releaseStream],
  );

  // Lifecycle: start the stream when the dialog opens; release on close
  // OR on unmount. The cleanup in the same effect covers both paths.
  useEffect(() => {
    if (!open) {
      releaseStream();
      // Reset state so reopening lands fresh — otherwise a previous
      // preview would still be showing while the new stream warms up.
      setPhase("idle");
      setPreviewUrl(null);
      setCapturedFile(null);
      setError(null);
      return;
    }
    void startStream(facing);
    return () => {
      releaseStream();
    };
    // We deliberately don't include `facing` in deps — flipping facing
    // is handled by an explicit handler below that calls startStream.
    // Adding it here would race with the user-initiated flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function flipCamera() {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    void startStream(next);
  }

  // capture: snapshot the current video frame, encode JPEG, hold a File
  // ready for "Use photo". We stop the stream as soon as the snapshot
  // lands so the OS indicator goes off — if the user picks Retake we
  // restart, which costs maybe 200 ms. Worth it for the "is the camera
  // still on?" anxiety this saves.
  async function capture() {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      setError("The camera isn't ready yet — give it a second.");
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setError("The camera frame is empty. Try toggling the camera and back.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Your browser blocked the canvas needed to encode the photo.");
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    if (!blob) {
      setError("Couldn't encode the photo. Try Retake.");
      return;
    }
    // Stable filename including a UTC timestamp so a user capturing a
    // batch ends up with sortable, non-colliding names. ISO with
    // colons stripped because Windows filesystems reject them.
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const file = new File([blob], `capture-${stamp}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    // Build a data URL for the preview <img>. Object URLs would be
    // marginally cheaper but require manual revoke on unmount; data
    // URLs garbage-collect with the React tree.
    const reader = new FileReader();
    reader.onload = () => {
      setPreviewUrl(typeof reader.result === "string" ? reader.result : null);
    };
    reader.readAsDataURL(blob);

    setCapturedFile(file);
    setPhase("preview");
    // Release the camera now — we have the frame we need.
    releaseStream();
  }

  function retake() {
    setPreviewUrl(null);
    setCapturedFile(null);
    void startStream(facing);
  }

  function confirmUse() {
    if (!capturedFile) return;
    onCapture(capturedFile);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-5 w-5" />
            Capture image
          </DialogTitle>
          <DialogDescription>
            Take a photo with your device camera and upload it directly
            to Drive. JPEG, encoded at the best quality your camera
            supports.
          </DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden rounded-lg border bg-muted">
          {/*
            Aspect ratio is a fixed 16:9 box so the dialog doesn't
            jiggle when the stream resolution comes back. The video /
            preview <img> are absolute-positioned to cover.
          */}
          <div className="relative aspect-video w-full">
            {phase === "preview" && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Captured frame"
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-contain"
              />
            )}

            {phase === "starting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
                Starting camera…
              </div>
            )}

            {phase === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center">
                <X className="h-8 w-8 text-destructive" />
                <p className="text-sm text-foreground">{error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void startStream(facing)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="!justify-between gap-2 sm:!justify-between">
          <div>
            {phase === "streaming" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={flipCamera}
                title="Switch between front and back camera"
              >
                <SwitchCamera className="h-4 w-4" />
                Flip
              </Button>
            )}
          </div>
          <div className="flex flex-row items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {phase === "preview" ? (
              <>
                <Button type="button" variant="outline" onClick={retake}>
                  <RotateCcw className="h-4 w-4" />
                  Retake
                </Button>
                <Button type="button" onClick={confirmUse}>
                  <Camera className="h-4 w-4" />
                  Use photo
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={capture}
                disabled={phase !== "streaming"}
              >
                <Camera className="h-4 w-4" />
                Capture
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
