import { CommandSubjectDetectionEngine } from "./CommandSubjectDetectionEngine";
import { OpenCvFaceDetectionEngine } from "./OpenCvFaceDetectionEngine";
import type { DetectedBoundingBox, SubjectDetectionEngine, SubjectDetectionInput } from "./types";

export class SubjectDetectionUnavailableError extends Error {
  constructor() {
    super(
      "Détection de sujet indisponible : configurez PEAKCUT_TRACKER_COMMAND ou installez OpenCV (voir requirements-vision.txt)."
    );
    this.name = "SubjectDetectionUnavailableError";
  }
}

interface AvailabilityCheckedEngine extends SubjectDetectionEngine {
  isAvailable(): Promise<boolean>;
}

export interface AutoSubjectDetectionEngineOptions {
  commandEngineFactory?: () => SubjectDetectionEngine;
  openCvEngineFactory?: () => AvailabilityCheckedEngine;
}

/**
 * Chooses a real detection backend at call time, in priority order:
 *
 * 1. PEAKCUT_TRACKER_COMMAND, if configured — a user's own external engine
 *    always takes priority.
 * 2. The local OpenCV face detector, if it's actually available (Python +
 *    opencv-python-headless installed).
 * 3. Otherwise: an explicit SubjectDetectionUnavailableError. This NEVER
 *    silently substitutes a fake or centered result — "local-subject"
 *    tracking either really runs, or clearly fails. StableCenterFrameTracker
 *    remains available as its own, honestly-labeled, separate choice.
 */
export class AutoSubjectDetectionEngine implements SubjectDetectionEngine {
  readonly id = "auto-subject-detector";

  private readonly commandEngineFactory: () => SubjectDetectionEngine;
  private readonly openCvEngineFactory: () => AvailabilityCheckedEngine;

  constructor(options: AutoSubjectDetectionEngineOptions = {}) {
    this.commandEngineFactory = options.commandEngineFactory ?? (() => new CommandSubjectDetectionEngine());
    this.openCvEngineFactory = options.openCvEngineFactory ?? (() => new OpenCvFaceDetectionEngine());
  }

  async detect(input: SubjectDetectionInput): Promise<DetectedBoundingBox[]> {
    if (process.env.PEAKCUT_TRACKER_COMMAND) {
      return this.commandEngineFactory().detect(input);
    }

    const openCv = this.openCvEngineFactory();
    if (await openCv.isAvailable()) {
      return openCv.detect(input);
    }

    throw new SubjectDetectionUnavailableError();
  }
}
