import type { DatabaseSync } from "node:sqlite";
import type {
  Project,
  ProjectStatus,
  Segment,
  Source,
  Timeline,
  Transcript,
  WorkflowState,
} from "@/lib/domain/types";

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  updatedAt: string;
}

export interface ProjectRepository {
  createProject(ownerId: string, project: Project): void;
  getProjectById(id: string): Project | null;
  getProjectOwnerId(id: string): string | null;
  listProjectsByOwner(ownerId: string): ProjectSummary[];
  updateProject(id: string, project: Project): void;
  deleteProject(id: string): void;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  status: string;
  timeline_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  id: string;
  type: string;
  title: string;
  youtube_url: string | null;
  local_file_path: string | null;
  duration_sec: number;
  origin_timestamp: string;
  confidence: number;
}

interface TranscriptRow {
  language: string;
  provider_id: string;
  words_json: string;
}

interface WorkflowRow {
  phase: string;
  publication_policy: string;
  rights_confirmed: number;
  rights_confirmed_at: string | null;
  rights_confirmed_by: string | null;
}

interface SegmentRow {
  id: string;
  project_id: string;
  title: string;
  start_sec: number;
  end_sec: number;
  words_json: string;
  score_json: string | null;
  safe_zones_json: string;
  variants_json: string;
}

/**
 * Persists a Project across its normalized tables (projects, sources,
 * transcripts, workflows, segments) in a single transaction per write.
 * Never stores media bytes — `sources.local_file_path` is only ever a
 * path string, exactly as it already is in the domain model.
 */
export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  createProject(ownerId: string, project: Project): void {
    this.db.exec("BEGIN");
    try {
      this.insertProject(ownerId, project);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  updateProject(id: string, project: Project): void {
    this.db.exec("BEGIN");
    try {
      const ownerRow = this.db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(id) as
        | { owner_id: string }
        | undefined;
      if (!ownerRow) {
        throw new Error(`Projet introuvable : "${id}".`);
      }
      this.deleteNestedRows(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      this.insertProject(ownerRow.owner_id, project);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  getProjectOwnerId(id: string): string | null {
    const row = this.db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(id) as
      | { owner_id: string }
      | undefined;
    return row ? row.owner_id : null;
  }

  listProjectsByOwner(ownerId: string): ProjectSummary[] {
    const rows = this.db
      .prepare("SELECT id, title, status, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC")
      .all(ownerId) as Array<{ id: string; title: string; status: string; updated_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status as ProjectStatus,
      updatedAt: r.updated_at,
    }));
  }

  getProjectById(id: string): Project | null {
    const projectRow = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!projectRow) return null;

    const sourceRow = this.db.prepare("SELECT * FROM sources WHERE project_id = ?").get(id) as
      | SourceRow
      | undefined;
    if (!sourceRow) {
      throw new Error(`Données incohérentes : source manquante pour le projet "${id}".`);
    }
    const source: Source = {
      id: sourceRow.id,
      type: sourceRow.type as Source["type"],
      title: sourceRow.title,
      youtubeUrl: sourceRow.youtube_url ?? undefined,
      localFilePath: sourceRow.local_file_path ?? undefined,
      durationSec: sourceRow.duration_sec,
      originTimestamp: sourceRow.origin_timestamp,
      confidence: sourceRow.confidence,
    };

    const transcriptRow = this.db.prepare("SELECT * FROM transcripts WHERE project_id = ?").get(id) as
      | TranscriptRow
      | undefined;
    const transcript: Transcript | null = transcriptRow
      ? { language: transcriptRow.language, providerId: transcriptRow.provider_id, words: JSON.parse(transcriptRow.words_json) }
      : null;

    const workflowRow = this.db.prepare("SELECT * FROM workflows WHERE project_id = ?").get(id) as
      | WorkflowRow
      | undefined;
    if (!workflowRow) {
      throw new Error(`Données incohérentes : workflow manquant pour le projet "${id}".`);
    }
    const workflow: WorkflowState = {
      phase: workflowRow.phase as WorkflowState["phase"],
      publicationPolicy: workflowRow.publication_policy as WorkflowState["publicationPolicy"],
      rights: {
        confirmed: Boolean(workflowRow.rights_confirmed),
        confirmedAt: workflowRow.rights_confirmed_at,
        confirmedBy: workflowRow.rights_confirmed_by,
      },
    };

    const segmentRows = this.db
      .prepare("SELECT * FROM segments WHERE project_id = ? ORDER BY position ASC")
      .all(id) as unknown as SegmentRow[];
    const segments: Segment[] = segmentRows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      startSec: row.start_sec,
      endSec: row.end_sec,
      words: JSON.parse(row.words_json),
      score: row.score_json ? JSON.parse(row.score_json) : null,
      safeZones: JSON.parse(row.safe_zones_json),
      variants: JSON.parse(row.variants_json),
    }));

    const timeline: Timeline | null = projectRow.timeline_json ? JSON.parse(projectRow.timeline_json) : null;

    return {
      id: projectRow.id,
      title: projectRow.title,
      createdAt: projectRow.created_at,
      updatedAt: projectRow.updated_at,
      status: projectRow.status as ProjectStatus,
      source,
      transcript,
      segments,
      timeline,
      workflow,
    };
  }

  private insertProject(ownerId: string, project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, owner_id, title, status, timeline_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        ownerId,
        project.title,
        project.status,
        project.timeline ? JSON.stringify(project.timeline) : null,
        project.createdAt,
        project.updatedAt
      );

    this.db
      .prepare(
        `INSERT INTO sources (project_id, id, type, title, youtube_url, local_file_path, duration_sec, origin_timestamp, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.source.id,
        project.source.type,
        project.source.title,
        project.source.youtubeUrl ?? null,
        project.source.localFilePath ?? null,
        project.source.durationSec,
        project.source.originTimestamp,
        project.source.confidence
      );

    if (project.transcript) {
      this.db
        .prepare(`INSERT INTO transcripts (project_id, language, provider_id, words_json) VALUES (?, ?, ?, ?)`)
        .run(project.id, project.transcript.language, project.transcript.providerId, JSON.stringify(project.transcript.words));
    }

    this.db
      .prepare(
        `INSERT INTO workflows (project_id, phase, publication_policy, rights_confirmed, rights_confirmed_at, rights_confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.workflow.phase,
        project.workflow.publicationPolicy,
        project.workflow.rights.confirmed ? 1 : 0,
        project.workflow.rights.confirmedAt,
        project.workflow.rights.confirmedBy
      );

    const insertSegment = this.db.prepare(
      `INSERT INTO segments (id, project_id, position, title, start_sec, end_sec, words_json, score_json, safe_zones_json, variants_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    project.segments.forEach((segment, index) => {
      insertSegment.run(
        segment.id,
        project.id,
        index,
        segment.title,
        segment.startSec,
        segment.endSec,
        JSON.stringify(segment.words),
        segment.score ? JSON.stringify(segment.score) : null,
        JSON.stringify(segment.safeZones),
        JSON.stringify(segment.variants)
      );
    });
  }

  private deleteNestedRows(projectId: string): void {
    this.db.prepare("DELETE FROM segments WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM workflows WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM transcripts WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM sources WHERE project_id = ?").run(projectId);
  }
}
