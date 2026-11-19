<script lang="ts">
interface Props {
	width?: number;
	height?: number;
	class?: string;
}

let { width = 16, height = 16, class: className = "" }: Props = $props();
</script>

<!-- Hugging Face face (without the hands), single-colour so it follows the theme like the
     other provider logos. Paths taken from huggingface.co's own logo. -->
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="8.46 3 77.5 77.5"
  {width}
  {height}
  class={className}
  fill="currentColor"
>
  <path
    d="M81.96 41.75a34.75 34.75 0 1 0-69.5 0 34.75 34.75 0 0 0 69.5 0Zm-73.5 0a38.75 38.75 0 1 1 77.5 0 38.75 38.75 0 0 1-77.5 0Z"
  />
  <path
    d="M58.5 32.3c1.28.44 1.78 3.06 3.07 2.38a5 5 0 1 0-6.76-2.07c.61 1.15 2.55-.72 3.7-.32ZM34.95 32.3c-1.28.44-1.79 3.06-3.07 2.38a5 5 0 1 1 6.76-2.07c-.61 1.15-2.56-.72-3.7-.32Z"
  />
  <path
    d="M46.96 56.29c9.83 0 13-8.76 13-13.26 0-2.34-1.57-1.6-4.09-.36-2.33 1.15-5.46 2.74-8.9 2.74-7.19 0-13-6.88-13-2.38s3.16 13.26 13 13.26Z"
  />
  <path d="M70.71 37a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM24.21 37a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z" />
</svg>
