import type { Dict } from '../types';
import { zh } from './zh';

// 繁體中文以简体为基底。阶段 6 用 OpenCC 简→繁 + 少量人工校覆盖此文件。
// 暂时复用 zh，保证三语路由可用。
export const zhTW: Dict = zh;
