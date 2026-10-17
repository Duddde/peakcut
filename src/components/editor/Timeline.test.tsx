import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Segment } from "@/lib/domain/types";
import { MIN_CLIP_SEC, NUDGE_SEC, Timeline, boundsAfterDrag, secondsAtPointer } from "./Timeline";

function segment(id: string, startSec: number, endSec: number): Segment {
  return {
    id,
    projectId: "p1",
    title: `Clip ${id}`,
    startSec,
    endSec,
    words: [],
    score: null,
    safeZones: [],
    variants: [],
    renderPlan: null,
  };
}

const SEGMENTS = [segment("a", 10, 70), segment("b", 120, 180)];

describe("secondsAtPointer", () => {
  const rect = { left: 100, width: 400 };

  it("maps a position on the track to a time", () => {
    expect(secondsAtPointer(300, rect, 200)).toBe(100);
  });

  it("clamps outside the track rather than running off the timeline", () => {
    expect(secondsAtPointer(0, rect, 200)).toBe(0);
    expect(secondsAtPointer(9999, rect, 200)).toBe(200);
  });

  it("returns 0 for a track with no width, instead of NaN", () => {
    expect(secondsAtPointer(300, { left: 0, width: 0 }, 200)).toBe(0);
  });
});

describe("boundsAfterDrag", () => {
  const clip = { startSec: 10, endSec: 70 };

  it("moves only the dragged edge", () => {
    expect(boundsAfterDrag(clip, "start", 20, 300)).toEqual({ startSec: 20, endSec: 70 });
    expect(boundsAfterDrag(clip, "end", 50, 300)).toEqual({ startSec: 10, endSec: 50 });
  });

  it("never inverts the clip: dragging past the far edge stops at the minimum length", () => {
    expect(boundsAfterDrag(clip, "start", 999, 300)).toEqual({ startSec: 70 - MIN_CLIP_SEC, endSec: 70 });
    expect(boundsAfterDrag(clip, "end", 0, 300)).toEqual({ startSec: 10, endSec: 10 + MIN_CLIP_SEC });
  });

  it("stays inside the source", () => {
    expect(boundsAfterDrag(clip, "start", -50, 300).startSec).toBe(0);
    expect(boundsAfterDrag(clip, "end", 9999, 300).endSec).toBe(300);
  });
});

describe("Timeline", () => {
  it("places each clip where it actually is in the source", () => {
    render(
      <Timeline segments={SEGMENTS} totalDurationSec={200} selectedSegmentId="a" onSelect={() => {}} />
    );
    const clip = screen.getByRole("option", { name: /Clip a/ }).parentElement as HTMLElement;
    expect(clip.style.left).toBe("5%");
    expect(clip.style.width).toBe("30%");
  });

  it("selects a clip when it is clicked", () => {
    const onSelect = vi.fn();
    render(
      <Timeline segments={SEGMENTS} totalDurationSec={200} selectedSegmentId="a" onSelect={onSelect} />
    );
    fireEvent.click(screen.getByRole("option", { name: /Clip b/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("offers no trim handle or destructive action when read-only", () => {
    render(
      <Timeline
        segments={SEGMENTS}
        totalDurationSec={200}
        selectedSegmentId="a"
        onSelect={() => {}}
        readOnly
        onRetime={() => {}}
        onSplit={() => {}}
        onDelete={() => {}}
      />
    );
    expect(screen.queryByLabelText(/début du clip/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /supprimer ce clip/i })).not.toBeInTheDocument();
  });

  it("trims with the keyboard, so the edit does not require a mouse", () => {
    const onRetime = vi.fn();
    render(
      <Timeline
        segments={SEGMENTS}
        totalDurationSec={200}
        selectedSegmentId="a"
        onSelect={() => {}}
        onRetime={onRetime}
      />
    );

    fireEvent.keyDown(screen.getByLabelText("Début du clip Clip a"), { key: "ArrowRight" });
    expect(onRetime).toHaveBeenLastCalledWith("a", { startSec: 10 + NUDGE_SEC, endSec: 70 });

    fireEvent.keyDown(screen.getByLabelText("Fin du clip Clip a"), { key: "ArrowLeft" });
    expect(onRetime).toHaveBeenLastCalledWith("a", { startSec: 10, endSec: 70 - NUDGE_SEC });
  });

  it("cuts the selected clip in its middle", () => {
    const onSplit = vi.fn();
    render(
      <Timeline
        segments={SEGMENTS}
        totalDurationSec={200}
        selectedSegmentId="a"
        onSelect={() => {}}
        onRetime={() => {}}
        onSplit={onSplit}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /couper en deux/i }));
    expect(onSplit).toHaveBeenCalledWith("a", 40);
  });

  it("will not offer to cut a clip too short to survive it", () => {
    render(
      <Timeline
        segments={[segment("a", 0, MIN_CLIP_SEC)]}
        totalDurationSec={200}
        selectedSegmentId="a"
        onSelect={() => {}}
        onRetime={() => {}}
        onSplit={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /couper en deux/i })).toBeDisabled();
  });

  it("deletes the selected clip", () => {
    const onDelete = vi.fn();
    render(
      <Timeline
        segments={SEGMENTS}
        totalDurationSec={200}
        selectedSegmentId="b"
        onSelect={() => {}}
        onRetime={() => {}}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /supprimer ce clip/i }));
    expect(onDelete).toHaveBeenCalledWith("b");
  });
});
