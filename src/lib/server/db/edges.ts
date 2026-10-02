import type { ThesisEdge } from '../../models/types.ts';
import { prepare } from './index.ts';
import { rowToThesisEdge, thesisEdgeInsertParams, type ThesisEdgeRow } from './mappers.ts';

export function dbInsertThesisEdge(e: ThesisEdge): void {
	prepare(
		`INSERT INTO thesis_edges
		   (id, source_thesis_id, target_thesis_id, author_id, created_at)
		 VALUES
		   (@id, @source_thesis_id, @target_thesis_id, @author_id, @created_at)`
	).run(thesisEdgeInsertParams(e));
}

export function dbGetEdgesForTarget(target_thesis_id: string): ThesisEdge[] {
	const rows = prepare<ThesisEdgeRow>(
		`SELECT id, source_thesis_id, target_thesis_id, author_id, created_at
		 FROM thesis_edges WHERE target_thesis_id = ? ORDER BY created_at DESC`
	).all(target_thesis_id) as ThesisEdgeRow[];
	return rows.map(rowToThesisEdge);
}

export function dbGetEdgeById(id: string): ThesisEdge | undefined {
	const row = prepare<ThesisEdgeRow>(
		`SELECT id, source_thesis_id, target_thesis_id, author_id, created_at
		 FROM thesis_edges WHERE id = ?`
	).get(id) as ThesisEdgeRow | undefined;
	return row ? rowToThesisEdge(row) : undefined;
}

export function dbGetEdgeBySourceTarget(
	source_thesis_id: string,
	target_thesis_id: string
): ThesisEdge | undefined {
	const row = prepare<ThesisEdgeRow>(
		`SELECT id, source_thesis_id, target_thesis_id, author_id, created_at
		 FROM thesis_edges WHERE source_thesis_id = ? AND target_thesis_id = ?`
	).get(source_thesis_id, target_thesis_id) as ThesisEdgeRow | undefined;
	return row ? rowToThesisEdge(row) : undefined;
}

export function dbDeleteThesisEdge(id: string): boolean {
	const info = prepare(`DELETE FROM thesis_edges WHERE id = ?`).run(id);
	return info.changes > 0;
}
