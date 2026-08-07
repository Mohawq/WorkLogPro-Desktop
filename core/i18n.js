// core/i18n.js — EN/AR invoice strings.
// Pure data: the INVOICE_I18N dictionary consumed by
// core/invoicing.js's generateInvoiceHTML(). RTL layout itself is handled
// via CSS `direction` inside generateInvoiceHTML (see invoicing.js) rather
// than by any function living in this file — there was no separate
// standalone "RTL helper" in the original code to extract.

      const INVOICE_I18N = {
        en: {
          invoice: "Invoice",
          billTo: "Bill To",
          invoiceNumber: "Invoice Number",
          dateIssued: "Date Issued",
          date: "Date",
          description: "Description",
          hours: "Hours",
          rate: "Rate",
          amount: "Amount",
          workSummary: "Work Summary",
          expenses: "Expenses",
          subtotal: "Subtotal",
          discount: "Discount",
          total: "Total",
          notes: "Notes",
          thankYou: "Thank you for your business",
          authorizedSignature: "Authorized Signature",
        },
        ar: {
          invoice: "فاتورة",
          billTo: "إلى",
          invoiceNumber: "رقم الفاتورة",
          dateIssued: "تاريخ الإصدار",
          date: "التاريخ",
          description: "الوصف",
          hours: "الساعات",
          rate: "السعر",
          amount: "المبلغ",
          workSummary: "ملخص العمل",
          expenses: "المصاريف",
          subtotal: "المجموع الفرعي",
          discount: "الخصم",
          total: "الإجمالي",
          notes: "ملاحظات",
          thankYou: "شكراً لتعاملكم معنا",
          authorizedSignature: "التوقيع المعتمد",
        },
      };
