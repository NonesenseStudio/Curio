"use client";

import { useEffect, useState } from "react";
import { Input, Modal, Select } from "antd";
import type { KnowledgeNote } from "@/lib/types";
import { topics } from "@/lib/sources";

export type KnowledgeNoteDraft = Pick<
  KnowledgeNote,
  "title" | "body" | "excerpt" | "sourceUrl" | "articleId" | "topic"
>;

type Props = {
  open: boolean;
  initial?: Partial<KnowledgeNoteDraft>;
  onCancel: () => void;
  onSave: (note: KnowledgeNoteDraft) => boolean;
};

function focusNoteBody() {
  const fields = document.querySelectorAll<HTMLTextAreaElement>(
    ".note-ant-modal textarea",
  );
  Array.from(fields)
    .find((field) => field.getClientRects().length > 0)
    ?.focus();
}

export default function KnowledgeNoteModal({
  open,
  initial,
  onCancel,
  onSave,
}: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [topic, setTopic] = useState("");
  const [saveError, setSaveError] = useState("");
  const [emptyError, setEmptyError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title || "");
    setBody(initial?.body || "");
    setExcerpt(initial?.excerpt || "");
    setTopic(initial?.topic || "");
    setSaveError("");
    setEmptyError("");
  }, [
    open,
    initial?.title,
    initial?.body,
    initial?.excerpt,
    initial?.sourceUrl,
    initial?.articleId,
    initial?.topic,
  ]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      focusNoteBody();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");
    if (!body.trim() && !excerpt.trim()) {
      setEmptyError("写下内容或保留摘录后再保存。");
      focusNoteBody();
      return;
    }
    setEmptyError("");
    setSaving(true);
    const saved = onSave({
      title: title.trim() || undefined,
      body: body.trim() || undefined,
      excerpt: excerpt.trim() || undefined,
      sourceUrl: initial?.sourceUrl,
      articleId: initial?.articleId,
      topic: (topic || undefined) as KnowledgeNoteDraft["topic"],
    });
    setSaving(false);
    if (!saved) {
      setSaveError(
        "未能保存，请检查浏览器存储空间后重试。内容仍保留在此表单中。",
      );
      return;
    }
    setBody("");
    setExcerpt("");
    setTitle("");
    onCancel();
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title={
        <header className="note-dialog-header">
          <h2 id="note-dialog-title">写笔记</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            aria-label="关闭笔记窗口"
          >
            ×
          </button>
        </header>
      }
      footer={null}
      width={680}
      closable={false}
      keyboard
      maskClosable
      className="note-ant-modal"
      wrapClassName="note-dialog-wrap"
    >
      <form className="note-form" onSubmit={submit}>
        <label className="form-field">
          <span>笔记</span>
          <Input.TextArea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="记下一句话，或留一段摘录"
            rows={6}
          />
        </label>
        <label className="form-field">
          <span>标题（选填）</span>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="为笔记添加标题"
          />
        </label>
        <div className="form-field">
          <span>主题（选填）</span>
          <Select
            aria-label="主题（选填）"
            value={topic || undefined}
            onChange={(value: string) => setTopic(value)}
            placeholder="不指定主题"
            allowClear
            options={topics.map((entry) => ({
              value: entry.name,
              label: entry.name,
            }))}
          />
        </div>
        {excerpt && (
          <label className="form-field">
            <span>摘录（选填）</span>
            <Input.TextArea
              value={excerpt}
              onChange={(event) => setExcerpt(event.target.value)}
              rows={4}
            />
          </label>
        )}
        {emptyError && (
          <p className="form-error" role="alert">
            {emptyError}
          </p>
        )}
        {saveError && (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        )}
        <footer className="dialog-actions">
          <button type="button" className="button-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="button-primary" disabled={saving}>
            {saving ? "正在保存…" : "保存笔记"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
