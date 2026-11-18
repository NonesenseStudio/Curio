"use client";

import type { FeedItem, KnowledgeNote, SavedItem, Topic } from "@/lib/types";
import { topics, feedRoutes } from "@/lib/sources";
import { noteTopic } from "@/lib/note-topic";

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
  const counts = new Map<Topic, { savedItems: Set<string>; notes: number }>();
  for (const topic of topics)
    counts.set(topic.name, { savedItems: new Set(), notes: 0 });
  const allArticles = [...saved, ...feedItems];
  for (const item of saved)
    counts.get(item.topic)?.savedItems.add(item.link || item.id);
  for (const note of notes) {
    const topic = noteTopic(note, allArticles);
    const entry = topic ? counts.get(topic) : undefined;
    if (!entry) continue;
    entry.notes += 1;
  }
  const maximumArticleCount = Math.max(
    1,
    ...Array.from(counts.values(), (entry) => entry.savedItems.size),
  );
  const hasHistory =
    saved.length > 0 ||
    notes.some((note) => Boolean(noteTopic(note, allArticles)));

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
              const width = entry.savedItems.size
                ? Math.max(4, (entry.savedItems.size / maximumArticleCount) * 100)
                : 0;
              const followed = interests.includes(topic.name);
              const hidden = mutedTopics.includes(topic.name);
              const encoded = encodeURIComponent(topic.name);
              return (
                <div
                  className={`interest-map-row${followed ? " followed" : ""}`}
                  key={topic.name}
                >
                  <strong>{topic.name}</strong>
                  {entry.savedItems.size > 0 && (
                    <div className="interest-map-track" aria-hidden="true">
                      <span style={{ width: `${width}%` }} />
                    </div>
                  )}
                  <span className="interest-map-count">
                    {followed ? "已关注 · " : ""}
                    {hidden ? "已隐藏 · " : ""}
                    {entry.savedItems.size > 0 || entry.notes > 0 ? (
                      <>
                        <a href={`/collections?topic=${encoded}`}>
                          {entry.savedItems.size} 项收藏
                        </a>
                        {" · "}
                        <a href={`/notes?topic=${encoded}`}>
                          {entry.notes} 则笔记
                        </a>
                      </>
                    ) : (
                      "尚无收藏或笔记"
                    )}
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
          const sourceCount = new Set(
            feedRoutes
              .filter((route) => route.topic === topic.name)
              .map((route) => route.sourceId),
          ).size;
          return (
            <article className="topic-card" key={topic.name}>
              <div className="topic-card-copy">
                <h2>{topic.name}</h2>
                <p>{topic.description}</p>
                <span className="topic-availability">
                  {sourceCount ? `${sourceCount} 个订阅源` : "暂未配置订阅源"}
                  {hidden ? " · 已隐藏" : ""}
                </span>
                <a
                  className="text-action browse-topic"
                  href={`/?topic=${encodeURIComponent(topic.name)}`}
                >
                  浏览该主题
                </a>
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
