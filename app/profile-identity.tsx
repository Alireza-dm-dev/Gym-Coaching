"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getInitials } from "@/lib/initials";

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Photo or initials. A missing photo, or one that fails to load, shows the
 * initials derived from `name`; a failed URL is remembered so it is never
 * retried in a render loop, and nothing is written back to the server.
 */
export function Avatar({ name, photoUrl, className = "avatar", style, onClick, label }: {
  name: string; photoUrl: string | null; className?: string; style?: CSSProperties;
  onClick?: () => void; label?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const content = photoUrl && failedUrl !== photoUrl
    ? <img src={photoUrl} alt={name} onError={() => setFailedUrl(photoUrl)} />
    : getInitials(name);
  return onClick
    ? <button type="button" className={className} style={style} onClick={onClick} aria-label={label ?? `Open ${name} profile photo`}>{content}</button>
    : <span className={className} style={style}>{content}</span>;
}

export type ProfilePhotoController = {
  busy: boolean; error: string | null; upload: (file: File) => Promise<void>; remove: () => Promise<void>;
};

/**
 * Own-photo mutations against `PUT/DELETE /api/profile/photo`. The returned
 * URL is the only source of truth: state changes only after the server
 * confirms, and a failure leaves the current photo untouched.
 */
export function useProfilePhoto(apiFetch: ApiFetch, onPhotoUrl: (photoUrl: string | null) => void): ProfilePhotoController {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (request: () => Promise<Response>, failure: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (response.status === 401) return; // global auth handling already fired
      if (response.ok) {
        const payload = (await response.json()) as { photoUrl?: unknown };
        if (payload.photoUrl === null || (typeof payload.photoUrl === "string" && payload.photoUrl.startsWith("/api/photos/"))) {
          onPhotoUrl(payload.photoUrl);
          return;
        }
        setError(failure);
        return;
      }
      setError(response.status === 413 ? "Image must be 2 MB or smaller."
        : response.status === 415 ? "Choose a JPEG, PNG or WebP image."
        : response.status === 503 ? "Profile photo storage is unavailable."
        : failure);
    } catch {
      setError(failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onPhotoUrl]);

  const upload = useCallback(async (file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) { setError("Choose a JPEG, PNG or WebP image."); return; }
    if (file.size > MAX_BYTES) { setError("Image must be 2 MB or smaller."); return; }
    await run(() => apiFetch("/api/profile/photo", { method: "PUT", headers: { "Content-Type": file.type }, body: file }),
      "Could not update profile photo. Try again.");
  }, [apiFetch, run]);

  const remove = useCallback(
    () => run(() => apiFetch("/api/profile/photo", { method: "DELETE" }), "Could not remove profile photo. Try again."),
    [apiFetch, run]);

  return { busy, error, upload, remove };
}

/** Change / Remove controls for the signed-in user's own photo. */
export function PhotoActions({ photo, hasPhoto }: { photo: ProfilePhotoController; hasPhoto: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="photo-actions">
      <input ref={input} hidden type="file" aria-label="Choose profile photo" accept={ALLOWED_TYPES.join(",")}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void photo.upload(file); }} />
      <div className="photo-buttons">
        <Button type="button" variant="outline" disabled={photo.busy} onClick={() => input.current?.click()}>{photo.busy ? "Saving…" : "Change photo"}</Button>
        {hasPhoto && <Button type="button" variant="outline" disabled={photo.busy} onClick={() => void photo.remove()}>Remove photo</Button>}
      </div>
      <small className="photo-hint">JPEG, PNG or WebP, up to 2 MB</small>
      {photo.error && <p className="photo-error" role="alert">{photo.error}</p>}
    </div>
  );
}

/** Large photo or initials. Pass `photo` for the user's own profile; omit it for view-only. */
export function AvatarPreview({ open, onOpenChange, name, photoUrl, photo }: {
  open: boolean; onOpenChange: (open: boolean) => void; name: string; photoUrl: string | null; photo?: ProfilePhotoController;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-dialog photo-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{name || "Profile photo"}</DialogTitle>
          <DialogDescription>{photo ? "Your profile photo" : "Profile photo"}</DialogDescription>
        </DialogHeader>
        <Avatar name={name} photoUrl={photoUrl} className="photo-preview" />
        {photo && <PhotoActions photo={photo} hasPhoto={photoUrl !== null} />}
        <DialogFooter><Button className="wide-dark" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An avatar that opens a view-only preview (used for other people's photos). */
export function PreviewableAvatar({ name, photoUrl, className, style }: {
  name: string; photoUrl: string | null; className?: string; style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Avatar name={name} photoUrl={photoUrl} className={className} style={style} onClick={() => setOpen(true)} />
      <AvatarPreview open={open} onOpenChange={setOpen} name={name} photoUrl={photoUrl} />
    </>
  );
}

/** The app mark. Click opens an enlarged preview; it never navigates. */
export function AppLogo({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={compact ? "app-logo app-logo-compact" : "app-logo"} onClick={() => setOpen(true)} aria-label="Open Fit & Mischief logo">
        <img src="/app-logo.png" alt="Fit & Mischief App" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="logo-dialog">
          <DialogHeader>
            <DialogTitle className="visually-hidden">Fit & Mischief App logo</DialogTitle>
            <DialogDescription className="visually-hidden">Expanded app logo</DialogDescription>
          </DialogHeader>
          <img src="/app-logo.png" alt="Fit & Mischief App — Naughty & Strong Together" />
        </DialogContent>
      </Dialog>
    </>
  );
}
