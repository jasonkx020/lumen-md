# HTML in Markdown

Paragraph with a break.<br>Next line.

<details>
<summary>展开</summary>
Hidden details content.
</details>

Colored: <span style="color: #0f766e">teal text</span>

## HTML table with rowspan

<table border="1">
  <tr>
    <!-- 第一列合并5行 -->
    <td rowspan="5" style="padding: 10px; text-align: center; vertical-align: middle;">文件状态：草稿<br>保密级别：绝密</td>
    <td>文件标识：</td>
    <td>需求开发整个流程步骤简介</td>
  </tr>
  <tr>
    <td>当前版本：</td>
    <td>1.0</td>
  </tr>
  <tr>
    <td>作者：</td>
    <td>王跃林</td>
  </tr>
  <tr>
    <td>审核：</td>
    <td>刘永红</td>
  </tr>
  <tr>
    <td>完成日期：</td>
    <td>2024.06</td>
  </tr>
</table>

Dangerous should be stripped:

<script>alert(1)</script>

<iframe src="https://example.com"></iframe>

<link rel="stylesheet" href="x.css">

## Local link target

See [sibling](./other.md) and [anchor](#html-in-markdown).
