import type { NodeTask } from "../api";

export type AgendaTask = NodeTask & { node_title: string; due_date: string | null; recur: string | null; bucket: string };
export type Agenda = { buckets: Record<string, AgendaTask[]>; count: number; done?: AgendaTask[]; done_total?: number };
