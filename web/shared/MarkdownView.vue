<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
const props = defineProps<{ content: string }>();
const parser = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Model output must not execute HTML or silently load remote tracking images.
parser.renderer.rules.image = (tokens, index) =>
  `<span class="markdown-image">[Image: ${parser.utils.escapeHtml(tokens[index]?.content ?? "")}]</span>`;
const html = computed(() =>
  DOMPurify.sanitize(parser.render(props.content), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "input", "form", "iframe"],
  }),
);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- Markdown HTML passes through DOMPurify above. -->
  <div class="markdown-body" v-html="html" />
</template>
