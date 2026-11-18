"use client";

import type { ReactNode } from "react";
import { ConfigProvider } from "antd";

export default function AntdProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#8E332A",
          colorText: "#222222",
          colorTextSecondary: "#595959",
          colorTextPlaceholder: "#595959",
          colorBorder: "#D6D6D6",
          colorBgElevated: "#FFFFFF",
          colorBgMask: "rgba(36, 33, 30, 0.42)",
          fontFamily: "var(--sans)",
          borderRadius: 5,
          controlHeight: 44,
          fontSize: 14,
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
