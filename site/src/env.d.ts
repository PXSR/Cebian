/// <reference types="astro/client" />

// @fontsource-variable/* 是纯 CSS 包，不带类型声明。
// 给它们的 side-effect import 提供模块声明，消除 TS2882。
declare module '@fontsource-variable/*';

