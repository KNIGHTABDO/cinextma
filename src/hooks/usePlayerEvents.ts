import { syncHistory } from "@/actions/histories";
import { ContentType } from "@/types";
import { diff } from "@/utils/helpers";
import { useDocumentVisibility } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";
import useSupabaseUser from "./useSupabaseUser";

export type PlayerEventType = "play" | "pause" | "seeked" | "ended" | "timeupdate" | "error" | "playback_error";

export interface BasePlayerEventEnvelope<T> {
  type: "PLAYER_EVENT" | "MEDIA_DATA";
  data: T;
}

export interface VidlinkEventData {
  event: PlayerEventType;
  currentTime: number;
  duration: number;
  mtmdbId: number;
  mediaType: ContentType;
  season?: number;
  episode?: number;
}

export type VidlinkPlayerMessage = BasePlayerEventEnvelope<VidlinkEventData>;

export interface VidkingEventData {
  event: PlayerEventType;
  currentTime: number;
  duration: number;
  id: string | number;
  mediaType: ContentType;
  season?: number;
  episode?: number;
  progress?: number;
}

export type VidkingPlayerMessage = BasePlayerEventEnvelope<VidkingEventData>;

export interface UnifiedPlayerEventData {
  event: PlayerEventType;
  currentTime: number;
  duration: number;
  mediaId: string | number;
  mediaType: ContentType;
  season?: number;
  episode?: number;
  progress?: number;
}

export interface PlayerAdapter<RawMessage extends BasePlayerEventEnvelope<any>> {
  /** Domain origin for identifying source */
  origin: `https://${string}`;
  /** Converts raw → unified structure */
  parse: (raw: RawMessage) => UnifiedPlayerEventData | null;
}

export type AdapterMap = Record<string, PlayerAdapter<any>>;

export const playerAdapters = {
  vidlink: {
    origin: "https://vidlink.pro",
    parse: (raw) => {
      if (raw.type !== "PLAYER_EVENT") return null;
      const d = raw.data;
      return {
        ...d,
        mediaId: d.mtmdbId,
      };
    },
  } satisfies PlayerAdapter<VidlinkPlayerMessage>,

  vidking: {
    origin: "https://www.vidking.net",
    parse: (raw) => {
      if (raw.type !== "PLAYER_EVENT") return null;
      const d = raw.data;
      return {
        ...d,
        mediaId: d.id,
      };
    },
  } satisfies PlayerAdapter<VidkingPlayerMessage>,
} as const satisfies AdapterMap;

export interface UsePlayerEventsOptions {
  metadata?: { season?: number; episode?: number };
  saveHistory?: boolean;
  onPlay?: (data: UnifiedPlayerEventData) => void;
  onPause?: (data: UnifiedPlayerEventData) => void;
  onSeeked?: (data: UnifiedPlayerEventData) => void;
  onEnded?: (data: UnifiedPlayerEventData) => void;
  onTimeUpdate?: (data: UnifiedPlayerEventData) => void;
  source?: string;
  onError?: () => void;
}

export function usePlayerEvents(options: UsePlayerEventsOptions = {}) {
  const { data: user } = useSupabaseUser();
  const documentState = useDocumentVisibility();

  // Store options in a ref to prevent stale closures and infinite watchdog resets
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [lastEvent, setLastEvent] = useState<PlayerEventType | null>(null);
  const [lastCurrentTime, setLastCurrentTime] = useState(0);

  const eventDataRef = useRef<UnifiedPlayerEventData | null>(null);
  const hasStartedRef = useRef(false);

  const syncToServer = async (data: UnifiedPlayerEventData, completed?: boolean) => {
    const { saveHistory, metadata } = optionsRef.current;
    if (!saveHistory || !user) return;
    if (diff(data.currentTime, lastCurrentTime) <= 5) return; // prevent spam

    const payload: UnifiedPlayerEventData = {
      ...data,
      season: data.season || metadata?.season || 0,
      episode: data.episode || metadata?.episode || 0,
    };

    const { success, message } = await syncHistory(payload, completed);
    if (success) setLastCurrentTime(data.currentTime);
    else console.error("Save history failed:", message);
  };

  useEffect(() => {
    const { saveHistory } = optionsRef.current;
    if (!saveHistory || !user) return;
    if (documentState === "visible") return;
    if (!eventDataRef.current) return;
    syncToServer(eventDataRef.current);
  }, [documentState, lastCurrentTime]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const { saveHistory } = optionsRef.current;
      if (!saveHistory || !user) return;
      if (!eventDataRef.current) return;

      const payload = {
        ...eventDataRef.current,
        completed: eventDataRef.current.event === "ended",
      };
      navigator.sendBeacon("/api/player/save-history", JSON.stringify(payload));
    };

    const handleMessage = (event: MessageEvent) => {
      const adapter = Object.values(playerAdapters).find((a) => a.origin === event.origin);
      if (!adapter) return;

      // Mark the player as successfully loaded since we received communication from its origin
      hasStartedRef.current = true;

      let rawData: any;
      try {
        rawData = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch (err) {
        console.warn("Invalid JSON from player:", err);
        return;
      }

      const parsed = adapter.parse(rawData);
      if (!parsed) return;

      eventDataRef.current = parsed;
      setLastEvent(parsed.event);

      const { onPlay, onPause, onEnded, onSeeked, onTimeUpdate, onError } = optionsRef.current;

      switch (parsed.event) {
        case "play":
          hasStartedRef.current = true;
          setIsPlaying(true);
          onPlay?.(parsed);
          break;
        case "pause":
          setIsPlaying(false);
          onPause?.(parsed);
          break;
        case "ended":
          setIsPlaying(false);
          syncToServer(parsed, true);
          onEnded?.(parsed);
          break;
        case "seeked":
          hasStartedRef.current = true;
          setCurrentTime(parsed.currentTime);
          setDuration(parsed.duration);
          onSeeked?.(parsed);
          break;
        case "timeupdate":
          hasStartedRef.current = true;
          setCurrentTime(parsed.currentTime);
          setDuration(parsed.duration);
          onTimeUpdate?.(parsed);
          break;
        case "error":
        case "playback_error":
          console.warn("Player returned playback error. Triggering fallback...");
          onError?.();
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      if (eventDataRef.current) handleBeforeUnload();
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Ad Redirect & Hijack Shield: Intercepts when the iframe player attempts to redirect your main website
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (document.activeElement && document.activeElement.tagName === "IFRAME") {
        e.preventDefault();
        e.returnValue = "Preventing unauthorized redirect from the video player.";
        return "Preventing unauthorized redirect from the video player.";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // Auto-Fallback timeout: if a source is loaded but does not start playing/updating time within 12 seconds, switch to the next source!
  useEffect(() => {
    const { source } = optionsRef.current;
    if (!source) return;

    // Only run the timeout for players that actually support postMessage events
    const isSupported = Object.values(playerAdapters).some((adapter) =>
      source.startsWith(adapter.origin)
    );
    if (!isSupported) {
      console.log(`[Auto-Fallback] Skipping watchdog timer for unsupported media origin: ${source}`);
      return;
    }

    hasStartedRef.current = false;

    const timer = setTimeout(() => {
      if (!hasStartedRef.current) {
        console.warn(`[Auto-Fallback] Player source failed to load or play within timeout: ${source}`);
        optionsRef.current.onError?.();
      }
    }, 12000); // 12 seconds timeout

    return () => clearTimeout(timer);
  }, [options.source]); // Re-run only when the specific source string changes

  return { isPlaying, currentTime, duration, lastEvent };
}
