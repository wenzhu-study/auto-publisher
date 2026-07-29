export const DEFAULT_KEYHUB_URL = 'http://192.168.1.124:3636'

export const IMAGE_FIELDS = Object.freeze([
  {
    key: 'ap_img',
    prefix: 'about-us-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '应用场景图',
    gallery: false
  },
  {
    key: 'af_img',
    prefix: 'after-sales-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '售后服务配图',
    gallery: false
  },
  {
    key: 'hp_img',
    prefix: 'mobile-hot-products-banner-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '手机端 HotProducts 图',
    gallery: false
  },
  {
    key: 'mo_banner',
    prefix: 'mobile-banner-',
    pageKey: 'about',
    pageSlug: 'about-us',
    label: '手机端 banner',
    gallery: true
  },
  {
    key: 'pt_img',
    prefix: 'price-list-',
    pageKey: 'price-list',
    pageSlug: 'price-list',
    label: 'Price List 配图',
    gallery: false
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
