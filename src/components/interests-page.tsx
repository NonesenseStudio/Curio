"use client";

import Link from "next/link";
import type { FeedItem, KnowledgeNote, SavedItem, Topic } from "@/lib/types";
import { topics, sources } from "@/lib/sources";

type Props = {
  interests: Topic[];
  mutedTopics: string[];
  saved: SavedItem[];
  notes: KnowledgeNote[];
  feedItems: FeedItem[];
  onToggleInterest: (topic: Topic) => void;
};

export default function InterestsPage({
  interests,
  mutedTopics,
  saved,
  notes,
  feedItems,
  onToggleInterest,
}: Props) {
  const counts = new Map<Topic, { articles: Set<string>; notes: number }>();
  for (const topic of topics)
    counts.set(topic.name, { articles: new Set(), notes: 0 });
  const allArticles = [...saved, ...feedItems];
  const byLink = new Map(allArticles.map((item) => [item.link, item.id]));
  for (const item of saved) counts.get(item.topic)?.articles.add(item.id);
  for (const note of notes) {
    if (!note.topic) {
      const matching =
        allArticles.find((item) => item.id === note.articleId) ||
        allArticles.find((item) => item.link === note.sourceUrl);
      const topic = matching?.topic;
      if (topic) {
        const entry = counts.get(topic);
        entry?.articles.add(matching.id);
        if (entry) entry.notes += 1;
      }
      continue;
    }
    const entry = counts.get(note.topic);
    if (!entry) continue;
    if (note.sourceUrl && byLink.has(note.sourceUrl))
      entry.articles.add(byLink.get(note.sourceUrl)!);
    else if (note.articleId) entry.articles.add(note.articleId);
    else if (note.sourceUrl) entry.articles.add(note.sourceUrl);
    entry.notes += 1;
  }
  const maximumArticleCount = Math.max(
    1,
    ...Array.from(counts.values(), (entry) => entry.articles.size),
  );
  const hasHistory =
    saved.length > 0 || notes.some((note) => note.sourceUrl || note.topic);

  return (
    <section className="interest-page" aria-labelledby="interests-title">
      <header className="panel-heading-row">
        <div>
          <h1 id="interests-title">兴趣</h1>
          <p>选择想关注的主题，收藏和带来源的笔记会逐步形成主题分布。</p>
        </div>
      </header>

      <section className="interest-map" aria-labelledby="interest-map-title">
        <div className="section-heading">
          <h2 id="interest-map-title">我的兴趣地图</h2>
        </div>
        {hasHistory ? (
          <div className="interest-map-list">
            {topics.map((topic) => {
              const entry = counts.get(topic.name)!;
              const width = entry.articles.size
                ? Math.max(4, (entry.articles.size / maximumArticleCount) * 100)
                : 0;
              const followed = interests.includes(topic.name);
              return (
                <div
                  className={`interest-map-row${followed ? " followed" : ""}`}
                  key={topic.name}
                >
                  <Link href={`/?topic=${encodeURIComponent(topic.name)}`}>
                    {topic.name}
                  </Link>
                  <div className="interest-map-track" aria-hidden="true">
                    <span style={{ width: `${width}%` }} />
                  </div>
                  <span className="interest-map-count">
                    {followed ? "已关注 · " : ""}
                    {entry.articles.size} 篇 · {entry.notes} 则笔记
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="interest-map-empty">
            收藏文章或保存带来源的笔记后，这里会显示对应主题。
          </p>
        )}
      </section>

      <div className="topic-directory">
        {topics.map((topic) => {
          const selected = interests.includes(topic.name);
          const hidden = mutedTopics.includes(topic.name);
          const sourceCount = sources.filter(
            (source) => source.topic === topic.name,
          ).length;
          return (
            <article className="topic-card" key={topic.name}>
              <div className="topic-card-copy">
                <h2>{topic.name}</h2>
                <p>{topic.description}</p>
                <span className="topic-availability">
                  {sourceCount ? `${sourceCount} 个订阅源` : "暂未配置订阅源"}
                  {hidden ? " · 已隐藏" : ""}
                </span>
              </div>
              <button
                type="button"
                className={
                  selected
                    ? "button-secondary selected-interest"
                    : "button-secondary"
                }
                aria-pressed={selected}
                onClick={() => onToggleInterest(topic.name)}
              >
                {selected ? "已关注" : "关注主题"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
