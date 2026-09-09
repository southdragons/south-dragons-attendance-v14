import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-08',
  ssr: false,
  nitro: { cloudflare: { nodeCompat: true } },
  devtools: { enabled: false },
  runtimeConfig: { gasWebAppUrl: '', gasApiKey: '' },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  app: {
    head: {
      title: 'South Dragons | 出欠確認',
      htmlAttrs: { lang: 'ja', 'data-theme': 'dragons' },
      meta: [
        { name: 'description', content: 'South Dragonsの練習・試合の予定と出欠確認。' },
        { name: 'theme-color', content: '#174d36' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
})
