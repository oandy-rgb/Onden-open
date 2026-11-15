import { useEffect, useRef, useState, type ComponentProps } from "react";
import { AUDIO_SPEED_ATTR, AUDIO_SPEED_CLASS, audioSpeedLabel, nextAudioSpeed } from "@onden/markdown";
import { useT } from "../lib/i18n";
import { Pressable } from "./ui";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";

type MediaPlayerProps = {
  kind: "audio" | "video";
  src?: string;
  /** Video only. */
  poster?: string;
  className?: string;
  "aria-label"?: string;
  children?: ComponentProps<"video">["children"];
};

/** The one inline player: an `<audio>`/`<video>` in a wrapper of its own that
 *  fades out whatever is playing when the player goes away (note text, card).
 *  The wrapper is what React removes, so the element itself can still be moved
 *  out and faded (useFadeOutOnUnmount). Keep every caller a module-level
 *  component: a player that is re-created each render restarts playback. */
export function MediaPlayer({ kind, src, poster, className, children, "aria-label": label }: MediaPlayerProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [speed, setSpeed] = useState(1);
  // The speed button is `hidden` in the server's markup (it does nothing until
  // a script runs; mediaEnhance.ts shows it on the published pages). Here the
  // script is this component.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  useFadeOutOnUnmount(kind === "video" ? videoRef : audioRef);
  return (
    <span className="md-media-wrap">
      {kind === "video"
        // preload="metadata": only the header and the first frame download, so
        // the box shows a still of the clip instead of a black frame; the rest
        // waits until the reader presses play.
        ? <video ref={videoRef} className={className} src={src} poster={poster} controls preload="metadata" aria-label={label}>{children}</video>
        : <audio ref={audioRef} className={className} src={src} controls preload="metadata" aria-label={label}>{children}</audio>}
      {kind === "audio" && (
        <Pressable
          className={AUDIO_SPEED_CLASS} {...{ [AUDIO_SPEED_ATTR]: "" }} hidden={!live}
          aria-label={t("Playback speed")} title={t("Playback speed")}
          onClick={() => {
            const next = nextAudioSpeed(speed);
            if (audioRef.current) audioRef.current.playbackRate = next;
            setSpeed(next);
          }}
        >{audioSpeedLabel(speed)}</Pressable>
      )}
    </span>
  );
}
