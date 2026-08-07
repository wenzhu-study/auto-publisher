export const DEFAULT_KEYHUB_URL = 'http://192.168.1.124:3636'

const NEW_3_1_FIELD_KEYS = [
  'hot-products',
  'new-products',
  'all-products',
  'products',
  'about-us',
  'after-sales',
  'agentcy',
  'catalog',
  'contact-us',
  'faq',
  'home',
  'oem',
  'order-terms',
  'price-list',
  'quality-control'
]

const NEW_3_1_FIELDS = NEW_3_1_FIELD_KEYS.map((key) => ({
  key,
  prefix: `${key}-3-1-`,
  pageKey: ['hot-products', 'new-products'].includes(key) ? 'product-tag' : 'featured-page',
  pageSlug: ['hot-products', 'new-products'].includes(key) ? '' : key,
  label: `${key} · 3:1`,
  ratio: '3:1',
  gallery: false,
  optional: true,
  targetType: ['hot-products', 'new-products'].includes(key) ? 'tag-banner' : 'page-featured'
}))

export const IMAGE_FIELDS = Object.freeze([
  ...NEW_3_1_FIELDS,
  {
    key: 'ap_img',
    prefix: 'about-us-16-9-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '应用场景 · 16:9',
    ratio: '16:9',
    gallery: false,
    optional: true
  },
  {
    key: 'af_img',
    prefix: 'after-sales-1-1-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '售后服务 · 1:1',
    ratio: '1:1',
    gallery: false,
    optional: true
  },
  {
    key: 'hp_img',
    prefix: 'mobile-hot-products-banner-3-1-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '手机 HotProducts · 3:1',
    ratio: '3:1',
    gallery: false,
    optional: true
  },
  {
    key: 'mo_banner',
    prefix: 'mobile-banner-16-9-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '手机 Banner · 16:9',
    ratio: '16:9',
    gallery: true,
    optional: true
  },
  {
    key: 'pt_img',
    prefix: 'price-list-9-16-',
    pageKey: 'price-list',
    pageSlug: 'price-list',
    label: 'Price List · 9:16',
    ratio: '9:16',
    gallery: false,
    optional: true
  }
])

export const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

export const CONTENT_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
})
