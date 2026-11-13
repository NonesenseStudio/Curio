import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import "antd/dist/reset.css";
import "./globals.css";
import AntdProvider from "./antd-provider";

export const metadata: Metadata = {
  title: "Curio · 发现与阅读",
  description: "按兴趣发现内容，查看订阅摘要，收藏文章并记录笔记。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <AntdProvider>{children}</AntdProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
