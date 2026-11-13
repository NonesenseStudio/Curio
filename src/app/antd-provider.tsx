"use client";

import type { ReactNode } from "react";
import { ConfigProvider } from "antd";

export default function AntdProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#8E332A",
          colorText: "#24211E",
          colorTextSecondary: "#686159",
          colorTextPlaceholder: "#686159",
          colorBorder: "#B9B0A4",
          colorBgElevated: "#FFFDFA",
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
