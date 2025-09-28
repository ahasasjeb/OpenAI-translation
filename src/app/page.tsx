"use client";

import { useState } from 'react';

export default function Home() {
  const [sourceText, setSourceText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [model, setModel] = useState('gpt-4');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('zh');

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header with selectors */}
        <div className="mb-6 flex flex-col sm:flex-row items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">模型:</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm"
            >
              <option value="gpt-4">GPT-4</option>
              <option value="gpt-3.5">GPT-3.5</option>
              <option value="claude">Claude</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm"
            >
              <option value="auto">自动</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="ja">日文</option>
              <option value="ko">韩文</option>
            </select>
            <span className="text-gray-500">→</span>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm"
            >
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="ja">日文</option>
              <option value="ko">韩文</option>
            </select>
          </div>
        </div>

        {/* Translation area */}
        <div className="flex flex-col sm:flex-row gap-4 h-[600px]">
          {/* Source text area */}
          <div className="h-1/5 sm:h-full sm:flex-1">
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="输入要翻译的文本..."
              className="w-full h-full p-4 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Divider */}
          <div className="hidden sm:block w-px bg-gray-300 mx-2"></div>

          {/* Target text area */}
          <div className="h-4/5 sm:h-full sm:flex-1">
            <textarea
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              placeholder="翻译结果将显示在这里..."
              className="w-full h-full p-4 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-4 flex justify-center gap-4">
          <button className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
            翻译
          </button>
          <button className="px-6 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors">
            清空
          </button>
        </div>
      </div>
    </div>
  );
}
