import { mount } from 'svelte';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import App from './App.svelte';
import './app.css';
import './explorer.css';

mount(App, { target: document.getElementById('app')! });
