// 9.x：音乐 Provider 路由 —— 按 provider id 解析实现；未显式指定时回落到默认 provider，
// 找不到实现时 fail-closed 抛 E_MUSIC_PROVIDER_UNAVAILABLE。

import type { MusicProvider, MusicProviderId } from "./music-provider";

export class MusicRouter {
  constructor(
    private readonly providers: Map<MusicProviderId, MusicProvider>,
    private readonly getDefaultProviderId: () => MusicProviderId,
  ) {}

  resolve(explicitProvider?: MusicProviderId): MusicProvider {
    const id = explicitProvider ?? this.getDefaultProviderId();
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`E_MUSIC_PROVIDER_UNAVAILABLE:${id}`);
    return provider;
  }
}
