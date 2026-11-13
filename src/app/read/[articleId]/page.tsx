import ArticleReader from "@/components/article-reader";

export const dynamic = "force-dynamic";

export default function ReadPage({
  params,
}: {
  params: { articleId: string };
}) {
  return <ArticleReader articleId={params.articleId} />;
}
